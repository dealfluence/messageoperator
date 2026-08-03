import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openDb, SCHEMA_VERSION } from "../src/db.mjs";

let dir, dbPath;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-migrate-"));
  dbPath = path.join(dir, "store.db");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Hand-build a minimal v1-shaped store (gzip-blob era) to migrate from. */
function makeV1(dbPath) {
  const db = new DatabaseSync(dbPath);
  // faithful v1 message schema (the gzip-blob era): full metadata columns +
  // body_sha, plus the blob table. Only the v2 Maildir columns are missing.
  db.exec(`
    CREATE TABLE message (
      id INTEGER PRIMARY KEY, account TEXT NOT NULL, provider_msg_id TEXT NOT NULL,
      rfc_message_id TEXT, thread_id TEXT, date_utc INTEGER, from_addr TEXT,
      from_name TEXT, subject TEXT, size INTEGER, has_attachment INTEGER NOT NULL DEFAULT 0,
      to_json TEXT, cc_json TEXT, bcc_json TEXT,
      body_cached INTEGER NOT NULL DEFAULT 0, body_sha TEXT,
      UNIQUE(account, provider_msg_id));
    CREATE TABLE blob (sha TEXT PRIMARY KEY, size INTEGER, kind TEXT, pinned INTEGER, last_access_utc INTEGER);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(
    "INSERT INTO message(account,provider_msg_id,subject,body_cached,body_sha) VALUES(?,?,?,1,?)",
  ).run("a@gmail.com", "gm-1", "hello", "deadbeef");
  db.prepare(
    "INSERT INTO blob(sha,size,kind,pinned,last_access_utc) VALUES(?,?,?,?,?)",
  ).run("deadbeef", 10, "sent", 1, 1);
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','1')").run();
  db.close();
}

test("v1 store migrates to v2: adds Maildir columns, drops blob, keeps rows", () => {
  makeV1(dbPath);
  const db = openDb(dbPath); // triggers migration

  const version = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .get().value;
  assert.equal(Number(version), SCHEMA_VERSION);

  const cols = db
    .prepare("PRAGMA table_info(message)")
    .all()
    .map((c) => c.name);
  for (const c of [
    "maildir_file",
    "content_sha",
    "body_size",
    "body_kind",
    "body_pinned",
    "body_last_access",
  ]) {
    assert.ok(cols.includes(c), `column ${c} added`);
  }

  // blob table gone
  const blobTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='blob'",
    )
    .get();
  assert.equal(blobTable, undefined);

  // existing message row preserved; body marked uncached (old gzip blob is gone)
  const m = db
    .prepare("SELECT * FROM message WHERE provider_msg_id='gm-1'")
    .get();
  assert.equal(m.subject, "hello");
  assert.equal(m.body_cached, 0);

  db.close();
});

test("openDb on a fresh store stamps the current schema version", () => {
  const db = openDb(dbPath);
  const version = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .get().value;
  assert.equal(Number(version), SCHEMA_VERSION);
  db.close();
});
