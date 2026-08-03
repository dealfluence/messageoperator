/**
 * Where the ingest store lives and how it finds accounts + Gmail credentials.
 * It REUSES the existing Mailroom credential storage (broker/credentials +
 * broker/config.json) rather than inventing new secret handling — nothing
 * sensitive is copied, moved, printed, or committed.
 *
 *   MAILROOM_HOME         → existing mailroom home (accounts + credentials)
 *   MAILROOM_INGEST_HOME  → ingest store/blobs/logs (default ~/mailroom-ingest)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ingestHome() {
  return (
    process.env.MAILROOM_INGEST_HOME ||
    path.join(os.homedir(), "mailroom-ingest")
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

export function mailroomHome() {
  return process.env.MAILROOM_HOME || path.join(os.homedir(), "mailroom");
}

/** Accounts from the existing broker config: [{provider, address, client_id?}]. */
export function loadAccounts() {
  const cfgPath = path.join(mailroomHome(), "broker", "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return Array.isArray(cfg.accounts) ? cfg.accounts : [];
  } catch {
    return [];
  }
}

/** Gmail app password for an address: env (bound) first, then the creds file. */
export function gmailPassword(address) {
  const envAddr = (process.env.MAILROOM_GMAIL_ADDRESS || "").toLowerCase();
  const envPw = process.env.MAILROOM_GMAIL_APP_PW;
  if (envPw && envAddr && envAddr === address.toLowerCase()) {
    return envPw.replace(/\s+/g, "");
  }
  const file = path.join(
    mailroomHome(),
    "broker",
    "credentials",
    `gmail_app_pw.${address.toLowerCase()}`,
  );
  try {
    return fs.readFileSync(file, "utf-8").replace(/\s+/g, "");
  } catch {
    return null;
  }
}
