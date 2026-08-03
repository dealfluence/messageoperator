import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.mjs";
import {
  backfillAllMail,
  attachmentsFromStructure,
} from "../src/gmail_source.mjs";
import {
  countArchived,
  findMessages,
  search,
  getBody,
  tagsOf,
} from "../src/store.mjs";

/** In-memory read-only Gmail-IMAP fake. Records fetched UIDs to catch re-fetch. */
class FakeGmail {
  constructor(messages, { uidValidity = 100 } = {}) {
    this.messages = messages; // [{uid, envelope, internalDate, size, labels:Set, emailId, threadId, bodyStructure, source}]
    this.uidValidity = uidValidity;
    this.metaFetchedUids = []; // metadata fetches (dup ⇒ re-fetch bug)
    this.failOnMetaBatch = 0; // throw when this metadata-fetch call number is reached
    this._metaCalls = 0;
  }
  async list() {
    return [
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "[Gmail]/All Mail", specialUse: "\\All" },
      { path: "[Gmail]/Sent Mail", specialUse: "\\Sent" },
    ];
  }
  async mailboxOpen() {
    return { uidValidity: this.uidValidity, exists: this.messages.length };
  }
  async search(query) {
    const m = /^(\d+):\*$/.exec(query.uid);
    const from = m ? Number(m[1]) : 1;
    return this.messages.filter((x) => x.uid >= from).map((x) => x.uid);
  }
  async *fetch(range, fields) {
    const wanted = new Set(range);
    if (fields.source) {
      for (const x of this.messages)
        if (wanted.has(x.uid)) yield { uid: x.uid, source: x.source };
      return;
    }
    this._metaCalls += 1;
    if (this.failOnMetaBatch && this._metaCalls === this.failOnMetaBatch) {
      throw new Error("simulated connection drop");
    }
    for (const x of this.messages) {
      if (!wanted.has(x.uid)) continue;
      this.metaFetchedUids.push(x.uid);
      yield {
        uid: x.uid,
        envelope: x.envelope,
        internalDate: x.internalDate,
        size: x.size,
        labels: x.labels,
        emailId: x.emailId,
        threadId: x.threadId,
        bodyStructure: x.bodyStructure,
      };
    }
  }
}

function mkMsg(uid, over = {}) {
  return {
    uid,
    emailId: "gm-" + uid,
    threadId: "th-" + uid,
    size: 1000 + uid,
    internalDate: new Date(Date.UTC(2020, 0, 1) + uid * 86400000),
    labels: new Set(over.labels ?? ["\\Important"]), // default: archived (no \Inbox)
    envelope: {
      subject: over.subject ?? "subject " + uid,
      messageId: "<msg" + uid + "@x>",
      from: [
        {
          name: over.fromName ?? "Sender",
          address: over.from ?? "s" + uid + "@ex.com",
        },
      ],
      to: [{ name: "Me", address: "me@gmail.com" }],
    },
    bodyStructure: over.bodyStructure ?? {
      type: "text",
      subtype: "plain",
      size: 10,
    },
    source: Buffer.from(over.source ?? `From: x\r\n\r\nbody-${uid}`),
    ...over,
  };
}

let dir, db, mail;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-gmail-"));
  db = openDb(path.join(dir, "store.db"));
  mail = path.join(dir, "mail");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const parseBody = async (raw) => raw.toString();

test("attachmentsFromStructure walks multipart and finds attachments", () => {
  const struct = {
    type: "multipart",
    subtype: "mixed",
    childNodes: [
      { type: "text", subtype: "plain", size: 10 },
      {
        type: "application",
        subtype: "pdf",
        size: 900,
        disposition: "attachment",
        dispositionParameters: { filename: "a.pdf" },
      },
    ],
  };
  const atts = attachmentsFromStructure(struct);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filename, "a.pdf");
  assert.equal(atts[0].mime, "application/pdf");
});

test("backfill stores all messages, maps tags, indexes sent bodies", async () => {
  const msgs = [
    mkMsg(1, { labels: ["\\Inbox"] }), // inbox
    mkMsg(2, { labels: ["\\Important"] }), // archived
    mkMsg(3, { labels: ["\\Sent"], source: "From: me\r\n\r\nsent apple pie" }), // sent
    mkMsg(4, { labels: [] }), // archived, no labels
  ];
  const client = new FakeGmail(msgs);
  const res = await backfillAllMail(db, mail, {
    account: "me@gmail.com",
    client,
    batchSize: 10,
    parseBody,
  });
  assert.equal(res.stored, 4);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM message").get().c, 4);
  assert.equal(countArchived(db, "me@gmail.com"), 3); // uids 2,3,4 lack INBOX
  // sent body stored + searchable
  assert.equal(search(db, "apple").length, 1);
  const sent = findMessages(db, { account: "me@gmail.com", tag: "SENT" });
  assert.equal(sent.length, 1);
  assert.ok(getBody(db, mail, sent[0].id).toString().includes("apple"));
  // watermark caught_up
  const st = db
    .prepare("SELECT status,last_uid FROM sync_state WHERE account=?")
    .get("me@gmail.com");
  assert.equal(st.status, "caught_up");
  assert.equal(st.last_uid, 4);
});

test("kill mid-backfill then resume: watermark advances, no re-fetch, count grows", async () => {
  const msgs = Array.from({ length: 25 }, (_, i) => mkMsg(i + 1));
  const client = new FakeGmail(msgs);
  client.failOnMetaBatch = 2; // die during the 2nd metadata batch (batchSize 10)

  await assert.rejects(
    backfillAllMail(db, mail, {
      account: "me@gmail.com",
      client,
      batchSize: 10,
      parseBody,
    }),
    /simulated connection drop/,
  );
  // first batch (uids 1..10) committed; watermark at 10; status still in_progress
  const after1 = db
    .prepare("SELECT status,last_uid FROM sync_state WHERE account=?")
    .get("me@gmail.com");
  assert.equal(after1.last_uid, 10);
  assert.equal(after1.status, "in_progress");
  const count1 = db.prepare("SELECT COUNT(*) c FROM message").get().c;
  assert.equal(count1, 10);

  // resume on a FRESH client (as a process restart would) — no fault this time
  const client2 = new FakeGmail(msgs);
  await backfillAllMail(db, mail, {
    account: "me@gmail.com",
    client: client2,
    batchSize: 10,
    parseBody,
  });

  const finalCount = db.prepare("SELECT COUNT(*) c FROM message").get().c;
  assert.equal(finalCount, 25);
  // client 1 fetched exactly uids 1..10 before dying (no partial dup)
  assert.deepEqual(
    [...new Set(client.metaFetchedUids)].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  // resumed client fetched ONLY 11..25 — never re-fetched already-synced ids
  assert.deepEqual(
    [...new Set(client2.metaFetchedUids)].sort((a, b) => a - b),
    Array.from({ length: 15 }, (_, i) => i + 11),
  );
  const st = db
    .prepare("SELECT status,last_uid FROM sync_state WHERE account=?")
    .get("me@gmail.com");
  assert.equal(st.last_uid, 25);
  assert.equal(st.status, "caught_up");
});

test("incremental: after caught_up, only new higher-UID mail is fetched", async () => {
  const msgs = [mkMsg(1), mkMsg(2)];
  const client = new FakeGmail(msgs);
  await backfillAllMail(db, mail, {
    account: "me@gmail.com",
    client,
    batchSize: 10,
    parseBody,
  });
  const fetchedFirst = client.metaFetchedUids.length;
  // new mail arrives
  client.messages.push(mkMsg(3, { labels: ["\\Inbox"] }));
  const res = await backfillAllMail(db, mail, {
    account: "me@gmail.com",
    client,
    batchSize: 10,
    parseBody,
  });
  assert.equal(res.stored, 1); // only uid 3
  assert.equal(db.prepare("SELECT COUNT(*) c FROM message").get().c, 3);
  // uid 3 fetched once; 1 and 2 not re-fetched in the second pass
  assert.equal(client.metaFetchedUids.filter((u) => u === 3).length, 1);
  assert.equal(client.metaFetchedUids.length, fetchedFirst + 1);
});

test("uidvalidity change triggers a full re-scan", async () => {
  const msgs = [mkMsg(1), mkMsg(2)];
  const client = new FakeGmail(msgs, { uidValidity: 100 });
  await backfillAllMail(db, mail, {
    account: "me@gmail.com",
    client,
    batchSize: 10,
    parseBody,
  });
  // server rebuilds mailbox: same uids, new validity
  client.uidValidity = 200;
  await backfillAllMail(db, mail, {
    account: "me@gmail.com",
    client,
    batchSize: 10,
    parseBody,
  });
  // still 2 messages (idempotent upsert), no duplicates
  assert.equal(db.prepare("SELECT COUNT(*) c FROM message").get().c, 2);
  const st = db
    .prepare("SELECT uid_validity FROM sync_state WHERE account=?")
    .get("me@gmail.com");
  assert.equal(st.uid_validity, 200);
});
