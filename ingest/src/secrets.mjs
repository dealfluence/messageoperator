/**
 * Read-only, SYNCHRONOUS mirror of src/secrets.ts.
 *
 * The ingest CLI is plain .mjs and cannot import the TypeScript broker, and
 * ingest/cli.mjs needs the password inline (no await at that call site), so
 * the storage format is duplicated here on purpose. It only ever READS:
 * ingest never creates, updates or migrates a secret, and never generates a
 * master key — that stays the broker's job, so a background ingest run can
 * never move a user's secret around behind its back.
 *
 * Shape it has to agree on with src/secrets.ts:
 *   master key   OS store (macOS `security`, Windows DPAPI) or the 0600 file
 *                broker/credentials/master_key, 32 bytes as hex
 *   secrets      broker/credentials/secrets.json, AES-256-GCM
 *                { iv, authTag, data } in hex, AAD = the file's basename,
 *                plaintext = a flat { name: value } JSON object
 *
 * test/secrets.test.ts pins the two implementations against each other.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SECRET_SERVICE = "messageoperator";
export const MASTER_KEY_ACCOUNT = "master-key";
export const VOLUME_FILE = "secrets.json";
export const BACKEND_ENV = "MESSAGEOPERATOR_SECRET_BACKEND";

const KEY_BYTES = 32;

/** Same name as gmailSecretName() in src/secrets.ts. */
export function gmailSecretName(address) {
  return `gmail_app_pw.${address.toLowerCase()}`;
}

export function defaultBackend(env = process.env) {
  const forced = (env[BACKEND_ENV] ?? "").trim().toLowerCase();
  if (forced === "keychain" || forced === "dpapi" || forced === "file") {
    return forced;
  }
  const platform = os.platform();
  if (platform === "darwin") return "keychain";
  if (platform === "win32") return "dpapi";
  return "file";
}

const PS_UNPROTECT = `
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue } catch {}
$hex = [Console]::In.ReadToEnd().Trim()
$blob = [byte[]]::new($hex.Length / 2)
for ($i = 0; $i -lt $blob.Length; $i++) {
  $blob[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16)
}
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, $scope)
[Console]::Out.Write([BitConverter]::ToString($bytes).Replace('-', '').ToLower())
`;

function readTrimmed(file) {
  try {
    return fs.readFileSync(file, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function decodeKey(raw) {
  const value = (raw ?? "").trim();
  if (new RegExp(`^[0-9a-f]{${KEY_BYTES * 2}}$`).test(value)) {
    return Buffer.from(value, "hex");
  }
  const b64 = Buffer.from(value, "base64");
  return b64.length === KEY_BYTES ? b64 : null;
}

/** The master key, or null when it cannot be read from here. */
export function readMasterKeySync(credsDir, backend = defaultBackend()) {
  if (backend === "keychain") {
    try {
      // -i: the command arrives on stdin, matching the async implementation
      const out = execFileSync("security", ["-i"], {
        input: `find-generic-password -a ${MASTER_KEY_ACCOUNT} -s ${SECRET_SERVICE} -w\n`,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      const key = decodeKey(out);
      if (key) return key;
    } catch {
      /* no keychain item, or no `security` here */
    }
  } else if (backend === "dpapi") {
    const blob = readTrimmed(path.join(credsDir, "master_key.dpapi"));
    if (blob) {
      for (const exe of ["powershell.exe", "pwsh.exe"]) {
        try {
          const out = execFileSync(
            exe,
            [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(PS_UNPROTECT, "utf16le").toString("base64"),
            ],
            {
              input: blob,
              encoding: "utf-8",
              windowsHide: true,
              stdio: ["pipe", "pipe", "ignore"],
            },
          );
          const key = decodeKey(out);
          if (key) return key;
        } catch {
          /* not this PowerShell, or the blob is another account's */
        }
      }
    }
  }
  // the file backend's own storage, and the pre-keychain location elsewhere
  return decodeKey(readTrimmed(path.join(credsDir, "master_key")) ?? "");
}

/** Decrypt the secrets volume into a { name: value } object. */
export function readVolumeSync(credsDir, key) {
  const file = path.join(credsDir, VOLUME_FILE);
  const raw = readTrimmed(file);
  if (!raw || !key) return {};
  try {
    const env = JSON.parse(raw);
    if (!env?.iv || !env?.authTag || !env?.data) return {};
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(env.iv, "hex"),
    );
    decipher.setAAD(Buffer.from(`messageoperator:${VOLUME_FILE}`, "utf-8"));
    decipher.setAuthTag(Buffer.from(env.authTag, "hex"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(env.data, "hex")),
      decipher.final(),
    ]);
    const values = JSON.parse(plain.toString("utf-8"));
    return values && typeof values === "object" ? values : {};
  } catch {
    // wrong key, tampered file, or a format we do not know: report nothing
    return {};
  }
}

/**
 * The stored value for one secret, or null. `credsDir` is
 * <state home>/broker/credentials — the same directory src/secrets.ts uses.
 * Falls back to the pre-volume plaintext file, which older installs may still
 * have if the broker has not run since the upgrade.
 */
export function readSecretSync(credsDir, name, backend = defaultBackend()) {
  const key = readMasterKeySync(credsDir, backend);
  const value = readVolumeSync(credsDir, key)[name];
  if (value) return value;
  return readTrimmed(path.join(credsDir, name));
}
