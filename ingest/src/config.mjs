/**
 * Where the ingest store lives and how it finds accounts + Gmail credentials.
 * It REUSES the existing Message Operator credential storage (the OS keychain
 * or broker/credentials, via ./secrets.mjs, plus broker/config.json) rather
 * than inventing new secret handling — and it only ever reads: nothing
 * sensitive is copied, moved, printed, or committed.
 *
 *   MESSAGEOPERATOR_HOME        → existing state home (accounts + credentials)
 *   MESSAGEOPERATOR_INGEST_HOME → ingest store/blobs/logs
 *                                 (default ~/messageoperator-ingest)
 *
 * Pre-rename MAILROOM_* env names and ~/mailroom* directories are still
 * honored as fallbacks (v0.6 rename; drop at 1.0).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gmailSecretName, readSecretSync } from "./secrets.mjs";

function envVal(suffix) {
  return (
    process.env[`MESSAGEOPERATOR_${suffix}`] ??
    process.env[`MAILROOM_${suffix}`]
  );
}

/** Canonical dir, unless only the legacy one exists (pre-rename state). */
function probeDir(modern, legacy) {
  if (!fs.existsSync(modern) && fs.existsSync(legacy)) return legacy;
  return modern;
}

export function ingestHome() {
  return (
    envVal("INGEST_HOME") ||
    probeDir(
      path.join(os.homedir(), "messageoperator-ingest"),
      path.join(os.homedir(), "mailroom-ingest"),
    )
  );
}

export function storePaths() {
  const home = ingestHome();
  // `mail` is the Maildir root; per-account maildirs live at mail/<account>/
  return {
    home,
    db: path.join(home, "store.db"),
    mail: path.join(home, "mail"),
  };
}

export function stateHome() {
  return (
    envVal("HOME") ||
    probeDir(
      path.join(os.homedir(), "messageoperator"),
      path.join(os.homedir(), "mailroom"),
    )
  );
}

/** Accounts from the existing broker config: [{provider, address, client_id?}]. */
export function loadAccounts() {
  const cfgPath = path.join(stateHome(), "broker", "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return Array.isArray(cfg.accounts) ? cfg.accounts : [];
  } catch {
    return [];
  }
}

/** <state home>/broker/credentials — where the broker keeps its secrets. */
export function credentialsDir() {
  return path.join(stateHome(), "broker", "credentials");
}

/**
 * Gmail app password for an address: the bound env var first, then whatever
 * the broker stored (OS keychain, DPAPI, or file — see ingest/src/secrets.mjs).
 * Read-only: ingest never writes or migrates a secret.
 */
export function gmailPassword(address) {
  const envAddr = (envVal("GMAIL_ADDRESS") || "").toLowerCase();
  const envPw = envVal("GMAIL_APP_PW");
  if (envPw && envAddr && envAddr === address.toLowerCase()) {
    return envPw.replace(/\s+/g, "");
  }
  const stored = readSecretSync(credentialsDir(), gmailSecretName(address));
  return stored ? stored.replace(/\s+/g, "") : null;
}
