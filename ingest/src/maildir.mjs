/**
 * Per-account Maildir body store (plain, uncompressed .eml files) — the local,
 * interoperable on-disk format for the message bytes we hold. One FLAT Maildir
 * per account (mail/<account>/{cur,new,tmp}); labels do NOT map to folders —
 * they live in the SQLite index as a many-to-many tag set. Keeping the Maildir
 * flat is what avoids the original defect (folder-per-label can't represent
 * Gmail's many-to-many labels).
 *
 * Files are named by content sha256 + a Maildir `:2,<flags>` info suffix
 * (`!` instead of `:` on Windows, where colons are illegal in filenames), so
 * identical content dedups within an account and re-storing is idempotent.
 * Delivery is atomic: write to tmp/, then rename into cur/.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Maildir++ subfolders, separated by RETENTION LIFECYCLE (not by label):
//   .Sent  = outbound, pinned, permanent archive
//   .Cache = inbound, LRU-evictable body cache
// Labels always live in the SQLite index; the Maildir never encodes labels as
// folders (that would reintroduce the many-to-many defect).
export const SENT_BOX = ".Sent";
export const CACHE_BOX = ".Cache";

// Maildir info separator: ":" per spec, but NTFS treats ":" as an alternate-
// data-stream marker, so on Windows use "!" (the convention OfflineIMAP's
// maildir-windows-compatible option established).
export const INFO_SEP = process.platform === "win32" ? "!" : ":";

// `root` is the Maildir root (e.g. ~/mailroom-ingest/mail); each account gets a
// Maildir++ tree directly beneath it.
export function accountMaildir(root, account) {
  return path.join(root, account);
}

function ensureMaildir(dir) {
  for (const sub of ["cur", "new", "tmp"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
}

/**
 * Write a message body into an account's Maildir (idempotent by content).
 * opts.box selects a Maildir++ subfolder (SENT_BOX / CACHE_BOX; "" = root).
 * flags: Maildir flag letters (e.g. "S" = Seen). Returns { file, sha, size }
 * where `file` is the path relative to the account maildir
 * (e.g. ".Sent/cur/<name>").
 */
export function writeMessage(
  root,
  account,
  raw,
  { flags = "", sha = null, box = "" } = {},
) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const digest = sha || createHash("sha256").update(buf).digest("hex");
  const acctRoot = accountMaildir(root, account);
  ensureMaildir(acctRoot); // Maildir++ requires the root itself to be a maildir
  const boxDir = box ? path.join(acctRoot, box) : acctRoot;
  ensureMaildir(boxDir);
  // sanitize flags to the Maildir set, sorted (spec: ASCII order)
  const fl = [
    ...new Set(
      String(flags)
        .replace(/[^A-Za-z]/g, "")
        .split(""),
    ),
  ]
    .sort()
    .join("");
  const name = `${digest}${INFO_SEP}2,${fl}`;
  // rel always uses "/" so index rows stay portable across platforms
  const rel = path.posix.join(box || "", "cur", name);
  const dest = path.join(acctRoot, rel);
  if (!fs.existsSync(dest)) {
    const tmp = path.join(boxDir, "tmp", `${digest}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest); // atomic within the same filesystem
  }
  return { file: rel, sha: digest, size: buf.length };
}

/** Read a message body by its account-relative path. null if the file is gone. */
export function readMessage(root, account, rel) {
  if (!rel) return null;
  const p = path.join(accountMaildir(root, account), rel);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

/** Delete a message file (LRU eviction). Missing file is not an error. */
export function removeMessage(root, account, rel) {
  if (!rel) return;
  fs.rmSync(path.join(accountMaildir(root, account), rel), { force: true });
}
