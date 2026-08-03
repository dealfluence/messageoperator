import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.mjs";
import {
  upsertAccount,
  upsertMessage,
  storeBody,
  getBody,
  enforceLru,
  search,
  findMessages,
  countArchived,
  tagsOf,
} from "../src/store.mjs";

let dir, db, mail;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-store-"));
  db = openDb(path.join(dir, "store.db"));
  mail = path.join(dir, "mail");
  upsertAccount(db, "a@gmail.com", "gmail");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function msg(over = {}) {
  return {
    account: "a@gmail.com",
    providerMsgId: "gm-1",
    rfcMessageId: "<m1@x>",
    threadId: "t-1",
    dateUtc: Date.UTC(2026, 4, 15, 9, 0), // 15 May 2026
    fromAddr: "noreply@elisa.fi",
    fromName: "Elisa",
    subject: "Lasku toukokuu",
    size: 1234,
    hasAttachment: true,
    to: [{ name: "A", address: "a@gmail.com" }],
    tags: ["IMPORTANT"], // no INBOX ⇒ archived
    attachments: [
      { filename: "lasku.pdf", mime: "application/pdf", size: 900 },
    ],
    ...over,
  };
}

test("upsert is idempotent on (account, provider_msg_id)", () => {
  const r1 = upsertMessage(db, msg());
  assert.equal(r1.inserted, true);
  const r2 = upsertMessage(db, msg({ subject: "changed" }));
  assert.equal(r2.inserted, false);
  assert.equal(r2.id, r1.id);
  const n = db.prepare("SELECT COUNT(*) c FROM message").get().c;
  assert.equal(n, 1);
  assert.equal(
    db.prepare("SELECT subject FROM message WHERE id=?").get(r1.id).subject,
    "changed",
  );
});

test("tags + attachments are stored and archived query works", () => {
  const { id } = upsertMessage(db, msg());
  assert.deepEqual(tagsOf(db, id), ["IMPORTANT"]);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM attachment WHERE message_id=?").get(id)
      .c,
    1,
  );
  // archived: no INBOX
  assert.equal(countArchived(db, "a@gmail.com"), 1);
  const arch = findMessages(db, { account: "a@gmail.com", archived: true });
  assert.equal(arch.length, 1);
  const inbox = findMessages(db, { account: "a@gmail.com", archived: false });
  assert.equal(inbox.length, 0);
});

test("re-upsert replaces tags (adding INBOX un-archives)", () => {
  const { id } = upsertMessage(db, msg());
  upsertMessage(db, msg({ tags: ["INBOX", "IMPORTANT"] }));
  assert.deepEqual(tagsOf(db, id), ["IMPORTANT", "INBOX"]);
  assert.equal(countArchived(db, "a@gmail.com"), 0);
});

test("find by sender + date range (the Elisa validation shape)", () => {
  upsertMessage(db, msg());
  const since = Date.UTC(2026, 4, 15, 0, 0);
  const until = Date.UTC(2026, 4, 15, 23, 59);
  const hits = findMessages(db, {
    account: "a@gmail.com",
    sender: "elisa.fi",
    since,
    until,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].from_addr, "noreply@elisa.fi");
});

test("storeBody + getBody roundtrip; sent is pinned; file is plain in Maildir", () => {
  const { id } = upsertMessage(
    db,
    msg({ providerMsgId: "gm-sent", tags: ["SENT"] }),
  );
  const raw = Buffer.from("From: me\r\n\r\nhello body elisa");
  storeBody(db, mail, {
    messageId: id,
    raw,
    kind: "sent",
    bodyText: "hello body elisa",
  });
  const got = getBody(db, mail, id);
  assert.equal(got.toString(), raw.toString());
  const row = db
    .prepare(
      "SELECT body_cached,body_pinned,body_kind,maildir_file FROM message WHERE id=?",
    )
    .get(id);
  assert.equal(row.body_cached, 1);
  assert.equal(row.body_pinned, 1);
  assert.equal(row.body_kind, "sent");
  // sent bodies live in the pinned .Sent Maildir++ box, plain + byte-identical
  assert.match(row.maildir_file, /^\.Sent\/cur\//);
  const onDisk = fs.readFileSync(
    path.join(mail, "a@gmail.com", row.maildir_file),
  );
  assert.deepEqual(onDisk, raw);
});

test("outbound and inbound bodies are stored in separate Maildir++ boxes", () => {
  const s = upsertMessage(db, msg({ providerMsgId: "s", tags: ["SENT"] }));
  storeBody(db, mail, {
    messageId: s.id,
    raw: Buffer.from("sent body"),
    kind: "sent",
  });
  const i = upsertMessage(db, msg({ providerMsgId: "i", tags: ["IMPORTANT"] }));
  storeBody(db, mail, {
    messageId: i.id,
    raw: Buffer.from("inbound body"),
    kind: "inbound",
  });
  const sf = db
    .prepare("SELECT maildir_file FROM message WHERE id=?")
    .get(s.id).maildir_file;
  const inf = db
    .prepare("SELECT maildir_file FROM message WHERE id=?")
    .get(i.id).maildir_file;
  assert.match(sf, /^\.Sent\/cur\//);
  assert.match(inf, /^\.Cache\/cur\//);
});

test("FTS finds by subject and by stored body", () => {
  const { id } = upsertMessage(db, msg());
  assert.equal(search(db, "toukokuu").length, 1); // subject
  assert.equal(search(db, "bodyword").length, 0);
  storeBody(db, mail, {
    messageId: id,
    raw: Buffer.from("x"),
    kind: "sent",
    bodyText: "unique bodyword here",
  });
  assert.equal(search(db, "bodyword").length, 1); // body now indexed
  // metadata re-upsert must preserve the indexed body
  upsertMessage(db, msg({ subject: "new subject" }));
  assert.equal(search(db, "bodyword").length, 1);
  assert.equal(search(db, "new").length, 1);
});

test("LRU evicts inbound but never sent (pinned)", () => {
  // one sent (pinned), several inbound — distinct content so shas don't dedup
  const s = upsertMessage(db, msg({ providerMsgId: "sent", tags: ["SENT"] }));
  storeBody(db, mail, {
    messageId: s.id,
    raw: Buffer.alloc(1000, 1),
    kind: "sent",
  });
  for (let i = 0; i < 5; i++) {
    const m = upsertMessage(db, msg({ providerMsgId: "in-" + i }));
    storeBody(db, mail, {
      messageId: m.id,
      raw: Buffer.alloc(1000, i + 2),
      kind: "inbound",
    });
  }
  // cap inbound to ~2000 bytes ⇒ must evict 3 of 5 inbound, keep sent
  const evicted = enforceLru(db, mail, 2000);
  assert.ok(evicted >= 3, `evicted ${evicted}`);
  assert.equal(getBody(db, mail, s.id).length, 1000); // sent survives
  const inboundLeft = db
    .prepare(
      "SELECT COUNT(*) c FROM message WHERE body_cached=1 AND body_kind='inbound'",
    )
    .get().c;
  assert.ok(inboundLeft <= 2);
});

test("openDb is re-runnable (reopen existing store)", () => {
  const { id } = upsertMessage(db, msg());
  db.close();
  const db2 = openDb(path.join(dir, "store.db"));
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM message").get().c, 1);
  assert.deepEqual(tagsOf(db2, id), ["IMPORTANT"]);
  db2.close();
  db = openDb(path.join(dir, "store.db")); // so afterEach close() is valid
});
