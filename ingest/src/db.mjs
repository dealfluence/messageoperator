/**
 * SQLite schema + connection for the ingest store, on Node's built-in
 * `node:sqlite` (DatabaseSync). Provider-neutral; see DECISIONS.md §B5.
 *
 * All DDL is IF NOT EXISTS and re-runnable — opening an existing store is a
 * no-op. WAL mode so a reader (coverage) never blocks the writer (backfill).
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS account (
  address  TEXT PRIMARY KEY,
  provider TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
  id             INTEGER PRIMARY KEY,
  account        TEXT NOT NULL,
  provider_msg_id TEXT NOT NULL,   -- Gmail X-GM-MSGID / Graph message id
  rfc_message_id TEXT,             -- RFC822 Message-ID header
  thread_id      TEXT,             -- X-GM-THRID / Graph conversationId
  date_utc       INTEGER,          -- epoch ms (internalDate, Date header fallback)
  from_addr      TEXT,
  from_name      TEXT,
  subject        TEXT,
  size           INTEGER,
  has_attachment INTEGER NOT NULL DEFAULT 0,
  to_json        TEXT,             -- JSON array of {name,address}
  cc_json        TEXT,
  bcc_json       TEXT,
  body_cached    INTEGER NOT NULL DEFAULT 0,
  maildir_file   TEXT,             -- account-relative path in the Maildir (cur/<name>)
  content_sha    TEXT,             -- sha256 of the stored body (dedup / integrity)
  body_size      INTEGER,          -- stored body bytes (for LRU accounting)
  body_kind      TEXT,             -- 'sent' (pinned) | 'inbound' (LRU-evictable)
  body_pinned    INTEGER NOT NULL DEFAULT 0,
  body_last_access INTEGER,        -- epoch ms, for LRU
  UNIQUE(account, provider_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_message_account_date ON message(account, date_utc);
CREATE INDEX IF NOT EXISTS idx_message_rfc ON message(rfc_message_id);
CREATE INDEX IF NOT EXISTS idx_message_thread ON message(thread_id);
-- LRU scan over cached inbound bodies
CREATE INDEX IF NOT EXISTS idx_message_lru ON message(body_kind, body_pinned, body_last_access)
  WHERE body_cached=1;

CREATE TABLE IF NOT EXISTS tag (
  message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (message_id, tag)
);
-- (tag, message_id) so "which messages have/haven't INBOX" is index-only
CREATE INDEX IF NOT EXISTS idx_tag_tag ON tag(tag, message_id);

CREATE TABLE IF NOT EXISTS attachment (
  message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  filename   TEXT,
  mime       TEXT,
  size       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attachment_msg ON attachment(message_id);

CREATE TABLE IF NOT EXISTS sync_state (
  account        TEXT NOT NULL,
  mailbox        TEXT NOT NULL,
  uid_validity   INTEGER,
  last_uid       INTEGER NOT NULL DEFAULT 0,
  highest_modseq INTEGER,
  delta_token    TEXT,
  status         TEXT,               -- not_started|in_progress|caught_up|auth_blocked
  total_expected INTEGER,            -- server-reported count, for progress %
  updated_utc    INTEGER,
  PRIMARY KEY (account, mailbox)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  subject, addrs, body
);
`;

/** Open (creating if needed) the ingest store at `dbPath`. */
export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");
  // migrate BEFORE the DDL: a v1 message table must gain its v2 columns before
  // the DDL's v2 indexes (which reference those columns) are created.
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  migrate(db);
  db.exec(DDL);
  return db;
}

/** Forward-only migrations. v1 (gzip-blob store) → v2 (Maildir body store). */
function migrate(db) {
  const row = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .get();
  const current = row ? Number(row.value) : 0;
  if (current === SCHEMA_VERSION) return;

  if (current === 1) {
    // add the v2 body columns to an existing message table (best-effort)
    const cols = db
      .prepare("PRAGMA table_info(message)")
      .all()
      .map((c) => c.name);
    const add = (name, decl) => {
      if (!cols.includes(name))
        db.exec(`ALTER TABLE message ADD COLUMN ${name} ${decl}`);
    };
    add("maildir_file", "TEXT");
    add("content_sha", "TEXT");
    add("body_size", "INTEGER");
    add("body_kind", "TEXT");
    add("body_pinned", "INTEGER NOT NULL DEFAULT 0");
    add("body_last_access", "INTEGER");
    // v1 stored bodies in a gzip blob store that no longer exists; mark them
    // uncached so they are re-fetched into the Maildir on the next backfill.
    db.exec("UPDATE message SET body_cached=0 WHERE body_cached=1");
    db.exec("DROP TABLE IF EXISTS blob");
  }

  db.prepare(
    "INSERT INTO meta(key,value) VALUES('schema_version',?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(SCHEMA_VERSION));
}
