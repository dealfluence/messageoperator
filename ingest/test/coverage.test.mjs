import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.mjs";
import { upsertAccount, upsertMessage, storeBody } from "../src/store.mjs";
import { coverageReport, formatCoverage } from "../src/coverage.mjs";

let dir, db, mail;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-cov-"));
  db = openDb(path.join(dir, "store.db"));
  mail = path.join(dir, "mail");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("coverage reports counts, range, archived split, bodies, watermark, status", () => {
  upsertAccount(db, "a@gmail.com", "gmail");
  const m1 = upsertMessage(db, {
    account: "a@gmail.com",
    providerMsgId: "1",
    dateUtc: Date.UTC(2015, 0, 1),
    tags: ["INBOX"],
    subject: "s1",
  });
  const m2 = upsertMessage(db, {
    account: "a@gmail.com",
    providerMsgId: "2",
    dateUtc: Date.UTC(2026, 4, 15),
    tags: ["IMPORTANT"],
    subject: "s2",
  });
  const m3 = upsertMessage(db, {
    account: "a@gmail.com",
    providerMsgId: "3",
    dateUtc: Date.UTC(2024, 0, 1),
    tags: ["SENT"],
    subject: "s3",
  });
  storeBody(db, mail, {
    messageId: m3.id,
    raw: Buffer.from("hi"),
    kind: "sent",
  });
  db.prepare(
    "INSERT INTO sync_state(account,mailbox,uid_validity,last_uid,status,total_expected,updated_utc) VALUES(?,?,?,?,?,?,?)",
  ).run(
    "a@gmail.com",
    "[Gmail]/All Mail",
    11,
    4242,
    "caught_up",
    3,
    Date.now(),
  );

  const rep = coverageReport(db);
  assert.equal(rep.length, 1);
  const a = rep[0];
  assert.equal(a.total_indexed, 3);
  assert.equal(a.inbox, 1);
  assert.equal(a.archived, 2);
  assert.equal(a.sent_bodies_indexed, 1);
  assert.equal(a.oldest, new Date(Date.UTC(2015, 0, 1)).toISOString());
  assert.equal(a.newest, new Date(Date.UTC(2026, 4, 15)).toISOString());
  assert.equal(a.status, "caught_up");
  assert.equal(a.mailboxes[0].watermark, "11:4242");

  const text = formatCoverage(rep);
  assert.match(text, /a@gmail\.com/);
  assert.match(text, /archived: 2/);
  assert.match(text, /NOT-YET-SYNCED/); // the honesty disclaimer is present
});

test("account with in_progress mailbox reports in_progress, not caught_up", () => {
  upsertAccount(db, "b@gmail.com", "gmail");
  db.prepare(
    "INSERT INTO sync_state(account,mailbox,uid_validity,last_uid,status,total_expected,updated_utc) VALUES(?,?,?,?,?,?,?)",
  ).run(
    "b@gmail.com",
    "[Gmail]/All Mail",
    1,
    5,
    "in_progress",
    100,
    Date.now(),
  );
  const a = coverageReport(db)[0];
  assert.equal(a.status, "in_progress");
});

test("auth_blocked account is reported, not silently absent", () => {
  upsertAccount(db, "c@adeu.ai", "microsoft");
  db.prepare(
    "INSERT INTO sync_state(account,mailbox,status,updated_utc,last_uid) VALUES(?,?,?,?,0)",
  ).run("c@adeu.ai", "graph", "auth_blocked", Date.now());
  const a = coverageReport(db).find((x) => x.account === "c@adeu.ai");
  assert.equal(a.status, "auth_blocked");
  assert.equal(a.total_indexed, 0);
});
