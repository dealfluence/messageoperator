/**
 * SQLite schema + connection for the broker store (broker/store.db), on
 * Node's built-in `node:sqlite` (DatabaseSync) — a builtin, not a native
 * module, so the MCPB bundle stays prebuild-free. Ported from the ingest
 * POC's db.mjs and adapted to the messageoperator state model.
 *
 * All DDL is IF NOT EXISTS and re-runnable — opening an existing store is a
 * no-op. WAL mode so the in-room `mail` CLI (a separate process, read-only)
 * never blocks the broker's writes. The store is a rebuildable cache of
 * server state: when the file is unreadable it is recreated empty rather
 * than treated as fatal.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { log } from "./log.js";

export type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * Load node:sqlite via the runtime API instead of a static import: bundlers
 * (vite in tests, esbuild for dist) don't all recognize the prefix-only
 * builtin, and a missing module should fail with a version hint, not a
 * resolver stack trace.
 */
function sqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule?.("node:sqlite");
  if (!mod) {
    throw new Error(
      "the built-in 'node:sqlite' module is unavailable — Message Operator needs Node 22.13+ (24 recommended)",
    );
  }
  return mod;
}

export const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS account (
  address  TEXT PRIMARY KEY,
  provider TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
  id               INTEGER PRIMARY KEY,
  sha              TEXT NOT NULL UNIQUE, -- content sha12, or "gm:<msgid>" for metadata-only rows
  account          TEXT NOT NULL,
  folder           TEXT NOT NULL DEFAULT '',
  filename         TEXT NOT NULL DEFAULT '',
  path             TEXT NOT NULL DEFAULT '',  -- room-relative .eml path; '' = not on disk
  date_text        TEXT NOT NULL DEFAULT '',  -- raw Date header
  epoch            INTEGER NOT NULL DEFAULT 0, -- seconds
  from_text        TEXT NOT NULL DEFAULT '',
  to_text          TEXT NOT NULL DEFAULT '',
  subject          TEXT NOT NULL DEFAULT '',
  body_text        TEXT NOT NULL DEFAULT '',  -- extracted plain text (canonical; FTS mirrors it)
  labels_json      TEXT,                      -- JSON array; NULL = field absent
  provider_msg_id  TEXT,                      -- Gmail X-GM-MSGID / Graph message id
  rfc_message_id   TEXT,                      -- RFC 2822 Message-ID header
  meta_only        INTEGER NOT NULL DEFAULT 0,
  body_cached      INTEGER NOT NULL DEFAULT 0,
  maildir_file     TEXT,                      -- account-relative path of an on-demand body
  body_size        INTEGER,                   -- stored body bytes (LRU accounting)
  body_kind        TEXT,                      -- 'sent' (pinned) | 'inbound' (evictable)
  body_pinned      INTEGER NOT NULL DEFAULT 0,
  body_last_access INTEGER                    -- epoch ms, for LRU
);
CREATE INDEX IF NOT EXISTS idx_message_epoch ON message(epoch);
CREATE INDEX IF NOT EXISTS idx_message_account_epoch ON message(account, epoch);
CREATE INDEX IF NOT EXISTS idx_message_provider ON message(account, provider_msg_id);
CREATE INDEX IF NOT EXISTS idx_message_rfc ON message(account, rfc_message_id);
-- LRU scan over cached inbound bodies
CREATE INDEX IF NOT EXISTS idx_message_lru
  ON message(body_kind, body_pinned, body_last_access) WHERE body_cached=1;

-- Tags key on sha, not message id: \`mail tag\` works on any room file
-- (drafts included), which may have no message row.
CREATE TABLE IF NOT EXISTS tag (
  sha TEXT NOT NULL,
  tag TEXT NOT NULL,
  ts  TEXT,
  PRIMARY KEY (sha, tag)
);
CREATE INDEX IF NOT EXISTS idx_tag_tag ON tag(tag, sha);

-- Graph ids already handled, so a later pass does not re-store them. Scoped by
-- account: removing a mailbox must clear ITS ids, or a re-add of that mailbox
-- skips every message it had before (they read as "seen") and comes back empty.
-- Ids marked for capped/skipped messages have no message row, so the account
-- column is the only thing that can attribute them.
CREATE TABLE IF NOT EXISTS graph_seen (
  id      TEXT PRIMARY KEY,
  account TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_graph_seen_account ON graph_seen(account);

-- generic key/value sync state (uid watermarks, folder-name caches, ...)
CREATE TABLE IF NOT EXISTS kv_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- structured, resumable per-mailbox sync progress (historical backfill)
CREATE TABLE IF NOT EXISTS sync_state (
  account      TEXT NOT NULL,
  mailbox      TEXT NOT NULL,
  uid_validity INTEGER,
  last_uid     INTEGER NOT NULL DEFAULT 0,
  low_uid      INTEGER NOT NULL DEFAULT 0,   -- backfill floor (moves toward 1)
  cursor       TEXT,                          -- opaque provider cursor (Graph nextLink)
  status       TEXT NOT NULL DEFAULT 'not_started', -- not_started|in_progress|caught_up
  total_expected INTEGER,
  updated_utc  INTEGER,
  PRIMARY KEY (account, mailbox)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * The FTS index is an OPTIONAL accelerator over columns that live in the
 * message table: limited runtimes (Electron-embedded Node builds SQLite
 * without FTS5, as do some system Pythons reading this store) fall back to
 * LIKE scans and lose nothing but speed. Created separately from the main
 * DDL so its failure never fails the store.
 */
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  subject, addrs, body
);
`;

/**
 * Open (creating if needed) the broker store at `dbPath`. If the existing
 * file is not a usable SQLite database, it is moved aside and recreated —
 * everything in the store re-derives from the providers, so losing it is
 * an inconvenience, never data loss.
 */
export function openDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  try {
    return openAndMigrate(dbPath);
  } catch (err) {
    log.warn(`store.db unreadable (${err}); recreating it empty`);
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
    return openAndMigrate(dbPath);
  }
}

function openAndMigrate(dbPath: string): DatabaseSync {
  const db = new (sqlite().DatabaseSync)(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)",
    );
    migrate(db);
    db.exec(DDL);
    ensureFts(db);
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      /* half-open handle; the caller recreates the file */
    }
    throw err;
  }
}

/**
 * Best-effort FTS5 index creation. MESSAGEOPERATOR_DISABLE_FTS5=1 skips it (test
 * seam / operational escape hatch); a runtime without the fts5 module gets
 * the failure remembered in meta so later opens don't retry noisily.
 */
function ensureFts(db: DatabaseSync): void {
  const flagged = db
    .prepare("SELECT value FROM meta WHERE key='fts5'")
    .get() as { value: string } | undefined;
  if (
    process.env.MESSAGEOPERATOR_DISABLE_FTS5 === "1" ||
    flagged?.value === "0"
  ) {
    return;
  }
  try {
    db.exec(FTS_DDL);
  } catch (err) {
    log.warn(
      `this runtime's SQLite lacks FTS5 (${err}); search falls back to LIKE scans`,
    );
    db.prepare(
      "INSERT INTO meta(key,value) VALUES('fts5','0') " +
        "ON CONFLICT(key) DO UPDATE SET value='0'",
    ).run();
  }
}

/** true when the FTS index exists in this store (usable by this runtime). */
export function hasFts(db: DatabaseSync): boolean {
  try {
    return (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='message_fts'")
        .get() !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * Forward-only migrations. Runs BEFORE the DDL, so a table may not exist yet
 * (fresh store); every step must tolerate that.
 */
function migrate(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;
  if (current === SCHEMA_VERSION) return;
  if (current < 2) migrateGraphSeenToPerAccount(db);
  db.prepare(
    "INSERT INTO meta(key,value) VALUES('schema_version',?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(SCHEMA_VERSION));
}

/**
 * v1 -> v2: graph_seen gains an `account` column.
 *
 * Pre-v2 rows cannot be attributed to a mailbox, and an unattributable id is
 * exactly the bug: it survives that mailbox's removal and then makes a re-add
 * skip the message forever. So the legacy rows are DROPPED rather than
 * back-filled with a guess. Safe, because graph_seen is only a dedupe
 * accelerator — hasSha/hasProviderMsg still prevent duplicate rows, so the
 * cost is one re-scan of Graph history, and the benefit is that from v2 on
 * every id is attributable.
 */
function migrateGraphSeenToPerAccount(db: DatabaseSync): void {
  try {
    const exists =
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='graph_seen'")
        .get() !== undefined;
    if (!exists) return; // fresh store: the DDL below creates it correctly
    const columns = db.prepare("PRAGMA table_info(graph_seen)").all() as {
      name: string;
    }[];
    if (columns.some((c) => c.name === "account")) return;
    db.exec("DELETE FROM graph_seen");
    db.exec(
      "ALTER TABLE graph_seen ADD COLUMN account TEXT NOT NULL DEFAULT ''",
    );
    log.info(
      "store: graph_seen is now per-account; cleared legacy unattributable " +
        "ids (Graph history re-scans once, nothing is duplicated)",
    );
  } catch (err) {
    // A failed migration must not make the store unopenable: the worst case
    // is the old behaviour, not a broken install.
    log.warn(`graph_seen migration skipped (${err})`);
  }
}
