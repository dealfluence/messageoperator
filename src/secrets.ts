/**
 * Secret storage: one master key in the OS credential store, everything else
 * in encrypted files beside it.
 *
 * The OS store holds exactly ONE item — a 256-bit AES key. Every actual
 * secret (Gmail app passwords, the MSAL token cache) lives in an AES-256-GCM
 * file under broker/credentials/ that the master key unlocks. That split is
 * what keeps the design honest on all three platforms: the OS store is asked
 * once per process instead of once per read (a keychain or PowerShell spawn
 * costs 0.3–1.2s), and no keychain has to hold kilobytes of token cache.
 *
 * NO NATIVE MODULES. The .mcpb bundle is prebuild-free and platform-neutral,
 * so a compiled dependency (keytar, @azure/msal-node-extensions) would force a
 * C++ toolchain on every user. The OS stores are reached by spawning tools the
 * machine already has, and the key never appears in a process listing:
 *
 *   macOS    `security -i` — the add-generic-password command, key included,
 *            is written to the tool's STDIN, so argv carries only "-i".
 *            Service "messageoperator", account "master-key".
 *   Windows  PowerShell calling [System.Security.Cryptography.ProtectedData]
 *            at CurrentUser scope (DPAPI). The payload goes in on stdin and
 *            the protected blob comes back on stdout; WE write the blob to
 *            broker/credentials/master_key.dpapi.
 *   other    broker/credentials/master_key, mode 0600 (Linux, Docker). There
 *            is no Secret Service client here on purpose: every pure-JS D-Bus
 *            library needs a native addon for abstract sockets, which the
 *            bundle cannot build, and a container has no keyring anyway.
 *
 * Everything lives under broker/ — outside room/ — so neither the MCP tools
 * nor the in-room `mail` CLI can reach it (see Layout.jail).
 *
 * A read-only, synchronous mirror of this format lives in
 * ingest/src/secrets.mjs — the ingest CLI is plain .mjs and cannot import this
 * module. test/secrets.test.ts pins the two together, and
 * test/secrets_os.test.ts exercises the real OS stores when
 * MESSAGEOPERATOR_SECRET_IT=1.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Layout } from "./layout.js";
import { log } from "./log.js";

/** Keychain service name; also the label a user sees in Keychain Access. */
export const SECRET_SERVICE = "messageoperator";
/** The one account name in that service. */
export const MASTER_KEY_ACCOUNT = "master-key";
/** The encrypted secrets volume, relative to broker/credentials/. */
export const VOLUME_FILE = "secrets.json";

/**
 * Force a backend. Set to "file" by the test suite so no test can reach the
 * developer's real Keychain / Credential Manager, and usable in a container
 * where no platform store exists. It only ever weakens storage on purpose,
 * by the operator — nothing in the app sets it.
 */
export const BACKEND_ENV = "MESSAGEOPERATOR_SECRET_BACKEND";

export type BackendKind = "keychain" | "dpapi" | "file";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Secret names inside the volume. */
export function gmailSecretName(address: string): string {
  return `gmail_app_pw.${address.toLowerCase()}`;
}

// ---- process plumbing ----------------------------------------------

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command and resolves with its exit status. A *spawn* failure (no such
 * binary) rejects; a non-zero *exit* resolves, because "item not found" is an
 * ordinary answer from `security`. Injectable so the keychain and DPAPI
 * adapters are testable on a Linux CI runner that has neither.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  stdin?: string,
) => Promise<CommandResult>;

const spawnRunner: CommandRunner = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
          reject(err); // ENOENT/EACCES: never ran, so there is no exit status
          return;
        }
        const status = (err as (Error & { code?: number }) | null)?.code;
        resolve({
          code: err ? (typeof status === "number" ? status : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.end(stdin ?? "");
  });

/**
 * DPAPI through PowerShell, the literal .NET API. The payload arrives on
 * stdin and the answer leaves on stdout, so nothing is interpolated into the
 * script text and no secret reaches argv. Add-Type is needed on Windows
 * PowerShell 5.1 and harmless on PowerShell 7 (verified on both).
 */
const PS_PROTECT = `
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue } catch {}
$hex = [Console]::In.ReadToEnd().Trim()
$bytes = [byte[]]::new($hex.Length / 2)
for ($i = 0; $i -lt $bytes.Length; $i++) {
  $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16)
}
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$blob = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
[Console]::Out.Write([BitConverter]::ToString($blob).Replace('-', '').ToLower())
`;

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

/** Reads a SecureString clixml file left by an older Windows build. */
const PS_READ_CLIXML = `
$ErrorActionPreference = 'Stop'
$p = [Console]::In.ReadToEnd().TrimEnd([char]13, [char]10)
$sec = Import-Clixml -LiteralPath $p
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))
`;

const PS_CANDIDATES = ["powershell.exe", "pwsh.exe"];
/** First PowerShell that actually spawned; a spawn costs ~0.5s. */
let powershellExe: string | null = null;

export function defaultBackend(
  env: NodeJS.ProcessEnv = process.env,
): BackendKind {
  const forced = (env[BACKEND_ENV] ?? "").trim().toLowerCase();
  if (forced === "keychain" || forced === "dpapi" || forced === "file") {
    return forced;
  }
  if (forced && forced !== "auto") {
    log.warn(`ignoring ${BACKEND_ENV}=${forced}: expected keychain|dpapi|file`);
  }
  const platform = os.platform();
  if (platform === "darwin") return "keychain";
  if (platform === "win32") return "dpapi";
  return "file";
}

/**
 * Where secrets end up, in words a user can act on. The setup wizard's trust
 * panel and the CLI both say this, so both describe the same machine
 * truthfully — naming a directory that no longer holds the secret would be a
 * lie in the one place a user goes to check.
 */
export function secretStorageDescription(
  kind: BackendKind = defaultBackend(),
): string {
  const file = "an encrypted file on this computer";
  switch (kind) {
    case "keychain":
      return `${file}, unlocked by a key kept in your macOS Keychain`;
    case "dpapi":
      return `${file}, unlocked by a key that Windows encrypts for your account only`;
    case "file":
      return `${file}, with its key in a private file readable only by your user account`;
  }
}

// ---- the master key store (the only thing in the OS store) ---------

export interface MasterKeyStoreOptions {
  backend?: BackendKind;
  run?: CommandRunner;
  /** Overridden by the integration tests so they never touch real items. */
  service?: string;
  account?: string;
}

/** Hex only: it survives every tokenizer and shell we hand it to. */
function isHexKey(value: string): boolean {
  return new RegExp(`^[0-9a-f]{${KEY_BYTES * 2}}$`).test(value);
}

export class MasterKeyStore {
  readonly kind: BackendKind;
  private readonly run: CommandRunner;
  private readonly dir: string;
  private readonly service: string;
  private readonly account: string;

  constructor(layout: Layout, opts: MasterKeyStoreOptions = {}) {
    this.kind = opts.backend ?? defaultBackend();
    this.run = opts.run ?? spawnRunner;
    this.dir = layout.credentials;
    this.service = opts.service ?? SECRET_SERVICE;
    this.account = opts.account ?? MASTER_KEY_ACCOUNT;
  }

  /** The stored key, or null when there is none (or none we can read). */
  async read(): Promise<Buffer | null> {
    const raw = await this.readRaw();
    if (!raw) return null;
    const key = decodeKey(raw);
    if (!key) {
      log.error(
        `the stored master key is malformed; encrypted secrets cannot be read. ` +
          `Delete it to start over (${this.deleteHint()})`,
      );
      return null;
    }
    return key;
  }

  /**
   * Store a key only if none is stored yet; false means one already is.
   *
   * This is the load-bearing operation of the whole module. "The store refused
   * to create it" is the only reliable way to tell an existing-but-unreadable
   * key (locked keychain, denied ACL, another user's DPAPI blob) from no key at
   * all — and overwriting the former would destroy every secret it protects.
   * Because `security -i` reports per-command failures inconsistently, the
   * write is always verified by reading back what actually landed.
   */
  async createExclusive(key: Buffer): Promise<boolean> {
    const hex = key.toString("hex");
    switch (this.kind) {
      case "keychain": {
        // no -U: `security` refuses when the item already exists
        const res = await this.security(
          `add-generic-password -a ${this.account} -s ${this.service} -w ${hex}`,
        );
        if (res.code !== 0) {
          log.warn(`keychain refused a new master key: ${detail(res)}`);
          return false;
        }
        break;
      }
      case "dpapi": {
        const blob = await this.protect(hex);
        if (!writeNew(this.blobPath(), blob)) return false;
        break;
      }
      case "file":
        if (!writeNew(this.keyPath(), hex + "\n")) return false;
        break;
    }
    // trust nothing: only a read-back proves whose key is in there now
    const back = await this.read();
    if (back?.equals(key)) return true;
    log.warn(
      "a master key already exists and could not be replaced; leaving " +
        "encrypted secrets untouched",
    );
    return false;
  }

  async delete(): Promise<void> {
    if (this.kind === "keychain") {
      const res = await this.security(
        `delete-generic-password -a ${this.account} -s ${this.service}`,
      );
      if (res.code !== 0 && !/could not be found/i.test(res.stderr)) {
        log.warn(`keychain delete of the master key: ${detail(res)}`);
      }
    }
    fs.rmSync(this.blobPath(), { force: true });
    fs.rmSync(this.keyPath(), { force: true });
  }

  /**
   * Adopt a master key an older install left in a file — moving a state home
   * from Linux/Docker onto a Mac must not orphan every secret in it. Returns
   * the adopted key, or null when there was nothing to adopt.
   */
  async adoptKeyFile(): Promise<Buffer | null> {
    if (this.kind === "file") return null; // that file IS the store here
    const key = decodeKey(readTrimmed(this.keyPath()) ?? "");
    if (!key) return null;
    if (!(await this.createExclusive(key))) return null;
    fs.rmSync(this.keyPath(), { force: true });
    log.info(`moved the master key into the ${this.kind} store`);
    return key;
  }

  // ---- legacy per-secret items (migration only) --------------------

  /**
   * Read one pre-volume keychain item (service messageoperator, account =
   * the email address), as the first app-password implementation wrote them.
   * Delete this once no install predates the secrets volume.
   */
  async readLegacyItem(account: string): Promise<string | null> {
    if (this.kind !== "keychain") return null;
    const res = await this.security(
      `find-generic-password -a ${account} -s ${this.service} -w`,
    );
    return res.code === 0 ? res.stdout.trim() || null : null;
  }

  async deleteLegacyItem(account: string): Promise<void> {
    if (this.kind !== "keychain") return;
    await this.security(
      `delete-generic-password -a ${account} -s ${this.service}`,
    );
  }

  /** Unprotect a pre-volume DPAPI blob written by an older build. */
  async readLegacyBlob(file: string): Promise<string | null> {
    if (this.kind !== "dpapi") return null;
    const hex = readTrimmed(file);
    if (!hex) return null;
    try {
      const out = await this.unprotect(hex);
      return out ? Buffer.from(out, "hex").toString("utf-8").trim() : null;
    } catch {
      return null;
    }
  }

  /** Read a SecureString clixml file written by an older Windows build. */
  async readLegacyClixml(file: string): Promise<string | null> {
    if (this.kind !== "dpapi") return null;
    try {
      const res = await this.powershell(PS_READ_CLIXML, file);
      if (res.code !== 0) return null;
      return Buffer.from(res.stdout.trim(), "base64").toString("utf-8").trim();
    } catch {
      return null; // no PowerShell here; nothing to migrate
    }
  }

  // ---- backends ----------------------------------------------------

  private async readRaw(): Promise<string | null> {
    switch (this.kind) {
      case "keychain": {
        const res = await this.security(
          `find-generic-password -a ${this.account} -s ${this.service} -w`,
        );
        return res.code === 0 ? res.stdout.trim() || null : null;
      }
      case "dpapi": {
        const blob = readTrimmed(this.blobPath());
        if (!blob) return null;
        try {
          return await this.unprotect(blob);
        } catch (err) {
          log.warn(`DPAPI unprotect of the master key failed: ${err}`);
          return null;
        }
      }
      case "file":
        return readTrimmed(this.keyPath());
    }
  }

  /**
   * One `security` command, fed on STDIN via interactive mode so the key is
   * never a command-line argument (macOS shows argv to every process running
   * as this user). Our own constants and hex are all that ever go in here;
   * anything else is refused rather than quoted.
   */
  private security(command: string): Promise<CommandResult> {
    if (!/^[A-Za-z0-9 ._@:/+=-]+$/.test(command)) {
      throw new Error("refusing to send an unsafe command to `security`");
    }
    return this.run("security", ["-i"], command + "\n");
  }

  /** Runs one of the PS_* scripts; remembers which PowerShell works. */
  private async powershell(
    script: string,
    stdin: string,
  ): Promise<CommandResult> {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ];
    const candidates = powershellExe ? [powershellExe] : PS_CANDIDATES;
    let last: unknown;
    for (const exe of candidates) {
      try {
        const res = await this.run(exe, args, stdin);
        powershellExe = exe;
        return res;
      } catch (err) {
        last = err; // could not spawn this one; try the next
      }
    }
    throw new Error(
      `no usable PowerShell (tried ${candidates.join(", ")}): ${last}`,
    );
  }

  private async protect(hex: string): Promise<string> {
    const res = await this.powershell(PS_PROTECT, hex);
    const blob = res.stdout.trim();
    if (res.code !== 0 || !blob) {
      throw new Error(`DPAPI protect failed: ${detail(res)}`);
    }
    return blob;
  }

  private async unprotect(blob: string): Promise<string | null> {
    const res = await this.powershell(PS_UNPROTECT, blob);
    if (res.code !== 0) {
      log.warn(`DPAPI unprotect failed: ${detail(res)}`);
      return null;
    }
    return res.stdout.trim() || null;
  }

  private blobPath(): string {
    return path.join(this.dir, "master_key.dpapi");
  }

  private keyPath(): string {
    return path.join(this.dir, "master_key");
  }

  private deleteHint(): string {
    return this.kind === "keychain"
      ? `security delete-generic-password -a ${this.account} -s ${this.service}`
      : `delete ${this.kind === "dpapi" ? this.blobPath() : this.keyPath()}`;
  }
}

function decodeKey(raw: string): Buffer | null {
  const value = raw.trim();
  if (isHexKey(value)) return Buffer.from(value, "hex");
  // pre-hex dev builds stored base64; accept it so nobody is locked out
  const b64 = Buffer.from(value, "base64");
  return b64.length === KEY_BYTES ? b64 : null;
}

function detail(res: CommandResult): string {
  const text = (res.stderr || res.stdout).trim().split("\n")[0] ?? "";
  return `exit ${res.code}${text ? ` (${text.slice(0, 200)})` : ""}`;
}

function readTrimmed(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** 0600 before any content lands, and never a partial file in place. */
function writePrivateFile(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Write only if absent; false when the file already exists. */
function writeNew(file: string, data: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

// ---- master key access ---------------------------------------------

/** Master keys never change, so they are held for the process lifetime. */
const masterKeys = new Map<string, Buffer>();

/**
 * The master key for this state home, or null when there is none to be had.
 *
 * With `create`, a missing key is generated and claimed exclusively. A null
 * return then means the opposite of "no key": one IS stored and this process
 * cannot read it. Callers must treat that as "leave the ciphertext alone" —
 * refresh tokens are the only state in the tree that cannot be rebuilt.
 */
export async function masterKey(
  layout: Layout,
  opts: MasterKeyStoreOptions & { create?: boolean } = {},
): Promise<Buffer | null> {
  const cached = masterKeys.get(layout.home);
  if (cached) return cached;

  const store = new MasterKeyStore(layout, opts);
  const found = (await store.read()) ?? (await store.adoptKeyFile());
  if (found) {
    masterKeys.set(layout.home, found);
    return found;
  }
  if (!opts.create) return null;

  const fresh = crypto.randomBytes(KEY_BYTES);
  if (!(await store.createExclusive(fresh))) return null;
  masterKeys.set(layout.home, fresh);
  return fresh;
}

/** Drop the cached key — for tests, and after the key is deleted. */
export function forgetMasterKey(layout: Layout): void {
  masterKeys.delete(layout.home);
}

/** Test seam: forget every cached key. */
export function clearSecretCache(): void {
  masterKeys.clear();
}

// ---- the sealed-file envelope --------------------------------------

/**
 * On-disk shape of every encrypted file, hex-encoded:
 *   { "iv": <12 bytes>, "authTag": <16 bytes>, "data": <ciphertext> }
 *
 * The file's own basename is authenticated as additional data but never
 * stored, so a blob cannot be moved from one credential file to another and
 * still verify.
 */
interface SealedEnvelope {
  iv: string;
  authTag: string;
  data: string;
}

const LEGACY_MAGIC = Buffer.from("MOSEC1", "utf-8");

export function seal(
  key: Buffer,
  label: string,
  plaintext: string | Buffer,
): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(label));
  const input =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf-8") : plaintext;
  const data = Buffer.concat([cipher.update(input), cipher.final()]);
  const envelope: SealedEnvelope = {
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  };
  return JSON.stringify(envelope) + "\n";
}

/** Throws when the file is malformed, tampered with, or from another key. */
export function unseal(
  key: Buffer,
  label: string,
  raw: Buffer | string,
): Buffer {
  const buf = typeof raw === "string" ? Buffer.from(raw, "utf-8") : raw;
  if (buf.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)) {
    return unsealLegacy(key, label, buf);
  }
  const parsed: unknown = JSON.parse(buf.toString("utf-8"));
  const env = parsed as Partial<SealedEnvelope>;
  if (!env || !env.iv || !env.authTag || !env.data) {
    throw new Error("not a messageoperator sealed file");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(env.iv, "hex"),
  );
  decipher.setAAD(aad(label));
  decipher.setAuthTag(Buffer.from(env.authTag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(env.data, "hex")),
    decipher.final(),
  ]);
}

/**
 * The binary MAGIC|iv|tag|ciphertext envelope a pre-0.7 dev build wrote.
 * Read-only, so a machine that ran one is not signed out; drop this once no
 * such file can exist.
 */
function unsealLegacy(key: Buffer, label: string, blob: Buffer): Buffer {
  const head = LEGACY_MAGIC.length + IV_BYTES + TAG_BYTES;
  if (blob.length < head) throw new Error("truncated sealed file");
  const iv = blob.subarray(LEGACY_MAGIC.length, LEGACY_MAGIC.length + IV_BYTES);
  const tag = blob.subarray(LEGACY_MAGIC.length + IV_BYTES, head);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(label));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(blob.subarray(head)),
    decipher.final(),
  ]);
}

function aad(label: string): Buffer {
  return Buffer.from(`messageoperator:${label}`, "utf-8");
}

/**
 * Decrypt a sealed file. Missing, unreadable and undecryptable all answer
 * null — the caller carries on as if there were no file — but only a missing
 * file is silent; the rest say why in the log, because "the user is suddenly
 * signed out" needs an explanation next to it.
 */
export async function readSealedFile(
  layout: Layout,
  file: string,
  opts: MasterKeyStoreOptions = {},
): Promise<string | null> {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log.warn(`could not read ${file}: ${err}`);
    return null;
  }
  const key = await masterKey(layout, opts);
  if (!key) {
    log.warn(
      `${path.basename(file)} is encrypted but its master key is unavailable; ` +
        "treating it as absent (a sign-in may be needed)",
    );
    return null;
  }
  try {
    return unseal(key, path.basename(file), raw).toString("utf-8");
  } catch (err) {
    log.error(`could not decrypt ${path.basename(file)}: ${err}`);
    return null;
  }
}

/**
 * Encrypt and replace a sealed file. Returns false when nothing was written,
 * which happens when the master key is unavailable — never write plaintext,
 * and never clobber a blob we cannot read.
 */
export async function writeSealedFile(
  layout: Layout,
  file: string,
  data: string,
  opts: MasterKeyStoreOptions = {},
): Promise<boolean> {
  try {
    const key = await masterKey(layout, { ...opts, create: true });
    if (!key) {
      log.warn(`not writing ${path.basename(file)}: no master key available`);
      return false;
    }
    writePrivateFile(file, seal(key, path.basename(file), data));
    return true;
  } catch (err) {
    // callers include MSAL cache hooks: a throw would abort a token call
    log.error(`could not write ${path.basename(file)}: ${err}`);
    return false;
  }
}

// ---- the secrets volume --------------------------------------------

/**
 * The volume is read and decrypted on every access rather than cached: it is
 * a few hundred bytes and AES-GCM over that is microseconds, so there is
 * nothing to gain and a whole class of stale-value bugs to lose. (What IS
 * cached is the master key, because reading that costs a process spawn.) It
 * also means a password stored by the separate `set-gmail-password` process is
 * visible to the running server immediately.
 */
function volumePath(layout: Layout): string {
  return path.join(layout.credentials, VOLUME_FILE);
}

async function readVolume(
  layout: Layout,
  opts: MasterKeyStoreOptions,
): Promise<Record<string, string>> {
  const text = await readSealedFile(layout, volumePath(layout), opts);
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch (err) {
    log.error(`the secrets volume is not valid JSON: ${err}`);
    return {};
  }
}

/**
 * Re-read, modify, write. The window for two processes to interleave is the
 * few hundred microseconds between read and rename; the alternative (holding
 * the volume in memory) would widen it to the process lifetime.
 */
async function updateVolume(
  layout: Layout,
  opts: MasterKeyStoreOptions,
  mutate: (values: Record<string, string>) => void,
): Promise<boolean> {
  const values = await readVolume(layout, opts);
  mutate(values);
  return writeSealedFile(
    layout,
    volumePath(layout),
    JSON.stringify(values),
    opts,
  );
}

export async function getSecret(
  layout: Layout,
  name: string,
  opts: MasterKeyStoreOptions = {},
): Promise<string | null> {
  const values = await readVolume(layout, opts);
  const value = values[name];
  if (value) return value;
  return adoptLegacySecret(layout, name, opts);
}

export async function setSecret(
  layout: Layout,
  name: string,
  value: string,
  opts: MasterKeyStoreOptions = {},
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`refusing to store an empty ${name}`);
  const ok = await updateVolume(layout, opts, (values) => {
    values[name] = trimmed;
  });
  if (!ok) throw new Error(`could not store ${name}: see the log for why`);
}

export async function deleteSecret(
  layout: Layout,
  name: string,
  opts: MasterKeyStoreOptions = {},
): Promise<void> {
  const values = await readVolume(layout, opts);
  if (name in values) {
    await updateVolume(layout, opts, (v) => {
      delete v[name];
    });
  }
  await forgetLegacySecret(layout, name, opts);
}

// ---- migration from pre-volume storage ------------------------------

/**
 * Everything below is read-once migration for installs that predate the
 * secrets volume, in the order those builds shipped: a plaintext file, a
 * SecureString clixml, a per-address keychain item, a per-address DPAPI blob.
 * Whatever is found is moved into the volume and the old copy is deleted.
 * Safe to delete this section once no such install can exist.
 */
function legacyPaths(layout: Layout, name: string) {
  const base = path.join(layout.credentials, name);
  return { plain: base, xml: `${base}.xml`, blob: `${base}.dpapi` };
}

async function adoptLegacySecret(
  layout: Layout,
  name: string,
  opts: MasterKeyStoreOptions,
): Promise<string | null> {
  const { plain, xml, blob } = legacyPaths(layout, name);
  const store = new MasterKeyStore(layout, opts);
  const account = name.startsWith("gmail_app_pw.")
    ? name.slice("gmail_app_pw.".length)
    : name;

  const value =
    readTrimmed(plain) ??
    (fs.existsSync(blob) ? await store.readLegacyBlob(blob) : null) ??
    (fs.existsSync(xml) ? await store.readLegacyClixml(xml) : null) ??
    (await store.readLegacyItem(account));
  if (!value) return null;

  try {
    await setSecret(layout, name, value, opts);
  } catch (err) {
    // e.g. a locked keychain: keep working from the old copy, and KEEP it —
    // deleting it here would lose the secret outright
    log.warn(`could not move ${name} into the secrets volume: ${err}`);
    return value;
  }
  fs.rmSync(plain, { force: true });
  fs.rmSync(xml, { force: true });
  fs.rmSync(blob, { force: true });
  await store.deleteLegacyItem(account);
  log.info(`moved ${name} into the encrypted secrets volume`);
  return value;
}

/** Remove every pre-volume copy of a secret, so "remove mailbox" is honest. */
async function forgetLegacySecret(
  layout: Layout,
  name: string,
  opts: MasterKeyStoreOptions,
): Promise<void> {
  const { plain, xml, blob } = legacyPaths(layout, name);
  for (const p of [plain, xml, blob]) fs.rmSync(p, { force: true });
  const account = name.startsWith("gmail_app_pw.")
    ? name.slice("gmail_app_pw.".length)
    : name;
  await new MasterKeyStore(layout, opts).deleteLegacyItem(account);
}
