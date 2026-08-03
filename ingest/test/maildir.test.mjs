import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  accountMaildir,
  writeMessage,
  readMessage,
  removeMessage,
  SENT_BOX,
  CACHE_BOX,
  INFO_SEP,
} from "../src/maildir.mjs";

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-maildir-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("writes a flat per-account Maildir with cur/new/tmp", () => {
  const raw = Buffer.from("From: a\r\n\r\nhello");
  const { file } = writeMessage(root, "a@gmail.com", raw, { flags: "S" });
  const md = accountMaildir(root, "a@gmail.com");
  for (const sub of ["cur", "new", "tmp"]) {
    assert.ok(fs.existsSync(path.join(md, sub)), `${sub} exists`);
  }
  // file is under cur/ and carries a Maildir 2,<flags> info suffix
  assert.match(file, /^cur\//);
  assert.ok(file.endsWith(`${INFO_SEP}2,S`), `info suffix on ${file}`);
  assert.ok(fs.existsSync(path.join(md, file)));
});

test("stored file is PLAIN (uncompressed) and byte-identical", () => {
  const raw = Buffer.from("From: a\r\n\r\nplain body content");
  const { file } = writeMessage(root, "a@gmail.com", raw);
  const onDisk = fs.readFileSync(
    path.join(accountMaildir(root, "a@gmail.com"), file),
  );
  assert.deepEqual(onDisk, raw); // not gzipped
});

test("idempotent + content-dedup: same bytes => same file, written once", () => {
  const raw = Buffer.from("dup body");
  const a = writeMessage(root, "acc@x.com", raw);
  const b = writeMessage(root, "acc@x.com", raw);
  assert.equal(a.file, b.file);
  assert.equal(a.sha, b.sha);
  const curFiles = fs.readdirSync(
    path.join(accountMaildir(root, "acc@x.com"), "cur"),
  );
  assert.equal(curFiles.length, 1);
});

test("roundtrip read + remove", () => {
  const raw = Buffer.from("readme");
  const { file } = writeMessage(root, "a@gmail.com", raw);
  assert.deepEqual(readMessage(root, "a@gmail.com", file), raw);
  removeMessage(root, "a@gmail.com", file);
  assert.equal(readMessage(root, "a@gmail.com", file), null);
});

test("Maildir++ subfolders separate outbound (.Sent) from inbound (.Cache)", () => {
  const sent = writeMessage(root, "a@gmail.com", Buffer.from("sent msg"), {
    flags: "S",
    box: SENT_BOX,
  });
  const inb = writeMessage(root, "a@gmail.com", Buffer.from("inbound msg"), {
    box: CACHE_BOX,
  });
  assert.match(sent.file, /^\.Sent\/cur\//);
  assert.match(inb.file, /^\.Cache\/cur\//);
  const md = accountMaildir(root, "a@gmail.com");
  // each subfolder is a valid maildir (cur/new/tmp), and the root is too
  for (const box of ["", SENT_BOX, CACHE_BOX]) {
    for (const sub of ["cur", "new", "tmp"]) {
      assert.ok(
        fs.existsSync(path.join(md, box, sub)),
        `${box || "root"}/${sub}`,
      );
    }
  }
  // physically separate + both readable via the account-relative path
  assert.equal(
    readMessage(root, "a@gmail.com", sent.file).toString(),
    "sent msg",
  );
  assert.equal(
    readMessage(root, "a@gmail.com", inb.file).toString(),
    "inbound msg",
  );
  assert.equal(fs.readdirSync(path.join(md, SENT_BOX, "cur")).length, 1);
  assert.equal(fs.readdirSync(path.join(md, CACHE_BOX, "cur")).length, 1);
});

test("accounts are isolated in separate maildirs", () => {
  writeMessage(root, "a@x.com", Buffer.from("a"));
  writeMessage(root, "b@x.com", Buffer.from("b"));
  assert.ok(fs.existsSync(accountMaildir(root, "a@x.com")));
  assert.ok(fs.existsSync(accountMaildir(root, "b@x.com")));
  assert.equal(
    fs.readdirSync(path.join(accountMaildir(root, "a@x.com"), "cur")).length,
    1,
  );
});
