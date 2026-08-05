import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { findSystemPython, Layout, sha12 } from "../src/layout.js";
import type { MessageRow } from "../src/state.js";
import { makeIndex, makeLayout, sampleEml } from "./helpers.js";

// The CLI deliberately runs on the host's own Python 3 (never Node: the
// deployment machines only guarantee a system Python), so the tests drive
// it exactly the way the room shim does.
function mail(
  layout: Layout,
  args: string[],
  opts: { expectCode?: number } = {},
): { code: number; stdout: string; stderr: string } {
  const script = path.join(layout.bin, "mail.py");
  const python = findSystemPython();
  if (!python) {
    throw new Error("No system Python found for tests");
  }
  try {
    const stdout = execFileSync(python, [script, ...args], {
      cwd: layout.room,
      encoding: "utf-8",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    const code = typeof err.status === "number" ? err.status : -1;
    if (opts.expectCode !== undefined && code === opts.expectCode) {
      return { code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    if (opts.expectCode === undefined) throw err;
    throw new Error(
      `expected exit ${opts.expectCode}, got ${code}: ${err.stderr}`,
    );
  }
}

/** Store a full message: .eml on disk + its index row (as the broker would). */
function seedMessage(
  layout: Layout,
  subject: string,
  body: string,
  epoch: number,
  opts: Partial<MessageRow> = {},
): { rel: string; sha: string } {
  // a REAL Message-ID never contains whitespace; strict parsers truncate one
  const messageId = `<${subject.replace(/\s+/g, "-")}@x>`;
  const raw = sampleEml({ subject, body, messageId });
  const sha = sha12(raw);
  const filename = `${epoch}.${sha}.eml`;
  const dir = path.join(layout.accounts, "a@gmail.com", "mail", "INBOX", "cur");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), raw);
  const rel = `accounts/a@gmail.com/mail/INBOX/cur/${filename}`;
  const index = makeIndex(layout);
  index.insertMessage({
    sha,
    account: "a@gmail.com",
    folder: "INBOX",
    filename,
    path: rel,
    date: "Mon, 06 Jul 2026 10:00:00 +0000",
    epoch,
    from: "Alice <alice@example.com>",
    to: "bob@example.com",
    subject,
    body,
    rfcMessageId: messageId,
    ...opts,
  });
  index.close();
  return { rel, sha };
}

/** Index a metadata-only row (a backfilled message with no body on disk). */
function seedMeta(
  layout: Layout,
  subject: string,
  epoch: number,
  opts: Partial<MessageRow> = {},
): string {
  const sha = `gm:${subject}`;
  const index = makeIndex(layout);
  index.insertMessage({
    sha,
    account: "a@gmail.com",
    folder: "Archive",
    filename: "",
    path: "",
    date: "Mon, 05 Jan 2026 10:00:00 +0000",
    epoch,
    from: "Old Sender <old@example.com>",
    to: "me@gmail.com",
    subject,
    body: "",
    labels: [],
    gmailId: subject,
    rfcMessageId: `<${subject.replace(/\s+/g, "-")}@old>`,
    metaOnly: true,
    ...opts,
  });
  index.close();
  return sha;
}

describe("mail CLI (python/sqlite)", () => {
  it("prints usage on help and unknown verbs", () => {
    const layout = makeLayout();
    expect(mail(layout, ["help"]).stdout).toContain("usage: mail <verb>");
    const unknown = mail(layout, ["frobnicate"], { expectCode: 1 });
    expect(unknown.stderr).toContain("unknown verb");
  });

  it("indexes newest-first with id + path columns and a paging cursor", () => {
    const layout = makeLayout();
    const older = seedMessage(layout, "older", "aa", 100);
    seedMessage(layout, "newer", "bb", 200);
    const meta = seedMeta(layout, "ancient", 50);

    const out = mail(layout, ["index", "--limit", "1"]).stdout;
    expect(out).toContain("newer");
    expect(out).not.toContain("older");
    const cursorLine = out.trim().split("\n").at(-1)!;
    expect(cursorLine).toMatch(/^TOTAL 3 \/ cursor 200\./);

    const cursor = cursorLine.split("cursor ")[1]!;
    const page2 = mail(layout, ["index", "--before", cursor]).stdout;
    expect(page2).toContain("older");
    expect(page2).toContain("ancient");
    // full rows carry their path; metadata-only rows a "-"
    const olderLine = page2.split("\n").find((l) => l.includes("older"))!;
    expect(olderLine).toContain(older.rel);
    expect(olderLine).toContain(older.sha);
    const metaLine = page2.split("\n").find((l) => l.includes("ancient"))!;
    expect(metaLine.trim().endsWith("-")).toBe(true);
    expect(metaLine).toContain(meta);
  });

  it("filters the index per account", () => {
    const layout = makeLayout();
    seedMessage(layout, "mine", "x", 100);
    const out = mail(layout, ["index", "--account", "other@x.com"]).stdout;
    expect(out).toContain("TOTAL 0");
  });

  it("searches with AND terms, phrases, negation, and prefixes", () => {
    const layout = makeLayout();
    seedMessage(layout, "invoice open", "please send money", 100);
    seedMessage(layout, "invoice done", "settled, paid in full", 200);
    expect(mail(layout, ["search", "invoice -paid"]).stdout).toContain(
      "invoice open",
    );
    expect(mail(layout, ["search", "invoice -paid"]).stdout).not.toContain(
      "invoice done",
    );
    expect(mail(layout, ["search", '"paid in full"']).stdout).toContain(
      "invoice done",
    );
    // prefix matching: "invoi" finds both
    expect(
      mail(layout, ["search", "invoi"]).stdout.match(/invoice/g)!.length,
    ).toBeGreaterThanOrEqual(2);
    // metadata of not-downloaded mail is searchable
    seedMeta(layout, "ancient invoice", 50);
    expect(mail(layout, ["search", "ancient"]).stdout).toContain(
      "ancient invoice",
    );
  });

  it("searches with OR logic", () => {
    const layout = makeLayout();
    seedMessage(layout, "apple pie", "tasty dessert", 100);
    seedMessage(layout, "banana split", "sweet dessert", 200);
    seedMessage(layout, "cherry tart", "sour fruit", 300);

    const out = mail(layout, ["search", "apple OR banana"]).stdout;
    expect(out).toContain("apple pie");
    expect(out).toContain("banana split");
    expect(out).not.toContain("cherry tart");
  });

  it("reads a message by path, preferring the meta sidecar body", () => {
    const layout = makeLayout();
    const { rel } = seedMessage(layout, "hello", "the actual body", 100);
    const full = path.join(layout.room, rel);
    fs.writeFileSync(
      full + ".meta",
      "X-Messageoperator-Sha: x\nX-Messageoperator-Account: a@gmail.com\n\nmeta body wins\n",
    );
    const out = mail(layout, ["read", rel]).stdout;
    expect(out).toContain("Subject: hello");
    expect(out).toContain("meta body wins");
  });

  it("reads a message by id and lists attachments from the sidecar", () => {
    const layout = makeLayout();
    const { rel, sha } = seedMessage(layout, "with attachment", "body", 100);
    const full = path.join(layout.room, rel);
    fs.writeFileSync(
      full + ".meta",
      "X-Messageoperator-Sha: x\nX-Messageoperator-Account: a@gmail.com\n" +
        "X-Messageoperator-Attachments: attachments/x/report.pdf\n" +
        "X-Messageoperator-Attachment-Views: attachments/x/report.pdf.md\n" +
        "\nbody\n",
    );
    const out = mail(layout, ["read", sha]).stdout;
    expect(out).toContain("Subject: with attachment");
    expect(out).toContain(
      "Attachment: attachments/x/report.pdf (View: attachments/x/report.pdf.md)",
    );
  });

  it("answers [REMOTE] with metadata for a body not on disk", () => {
    const layout = makeLayout();
    const sha = seedMeta(layout, "far away", 50);
    const out = mail(layout, ["read", sha]).stdout;
    expect(out).toContain("Subject: far away");
    expect(out).toContain("[REMOTE] Body not on disk");
    expect(out).toContain(`mail fetch ${sha}`);
  });

  it("queues fetch requests for metadata-only ids", () => {
    const layout = makeLayout();
    const sha = seedMeta(layout, "wanted", 50);
    const { rel } = seedMessage(layout, "here", "x", 100);

    const out = mail(layout, ["fetch", sha]).stdout;
    expect(out).toContain(`FETCH queued: ${sha}`);
    expect(out).toContain("NOTE:");
    const lines = fs
      .readFileSync(path.join(layout.room, ".fetch-request.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].sha).toBe(sha);

    // a message already on disk queues nothing
    const shaOnDisk = sha12(fs.readFileSync(path.join(layout.room, rel)));
    const noop = mail(layout, ["fetch", shaOnDisk]).stdout;
    expect(noop).toContain("already on disk");

    // unknown ids fail loudly
    const bad = mail(layout, ["fetch", "nope"], { expectCode: 3 });
    expect(bad.stderr).toContain("no such message id");
  });

  it("writes a threaded reply draft", () => {
    const layout = makeLayout();
    const { rel } = seedMessage(layout, "hello", "original", 100);
    const bodyFile = path.join(layout.room, "reply-body.txt");
    fs.writeFileSync(bodyFile, "Thanks!\n");
    const draftRel = mail(layout, [
      "reply",
      rel,
      "reply-body.txt",
    ]).stdout.trim();
    expect(draftRel).toContain("mail/Drafts/cur/");
    const draft = fs.readFileSync(path.join(layout.room, draftRel), "utf-8");
    expect(draft).toContain("Subject: Re: hello");
    expect(draft).toContain("In-Reply-To: <hello@x>");
    expect(draft).toContain("References: <hello@x>");
    expect(draft).toContain("To: Alice <alice@example.com>");
    expect(draft).toContain("Thanks!");
  });

  it("refuses to reply to a metadata-only message", () => {
    const layout = makeLayout();
    const sha = seedMeta(layout, "remote thing", 50);
    fs.writeFileSync(path.join(layout.room, "b.txt"), "x");
    const out = mail(layout, ["reply", sha, "b.txt"], { expectCode: 2 });
    expect(out.stderr).toContain("mail fetch");
  });

  it("composes a draft and queues it for sending", () => {
    const layout = makeLayout();
    layout.ensureAccount("a@gmail.com");
    fs.writeFileSync(path.join(layout.room, "body.txt"), "Hello there\n");
    const draftRel = mail(layout, [
      "compose",
      "a@gmail.com",
      "to@example.com",
      "Greetings",
      "body.txt",
    ]).stdout.trim();
    expect(draftRel).toContain("mail/Drafts/cur/");

    const sent = mail(layout, ["send", draftRel]).stdout;
    expect(sent).toContain("INTENT queued:");
    expect(sent).toContain("NOTE:");
    const outboxNew = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Outbox",
      "new",
    );
    const files = fs.readdirSync(outboxNew);
    expect(files.some((f) => f.endsWith(".eml"))).toBe(true);
    expect(files.some((f) => f.endsWith(".intent.json"))).toBe(true);
  });

  it("send refuses drafts outside Drafts/ and attachments outside attachments/", () => {
    const layout = makeLayout();
    const { rel } = seedMessage(layout, "inbox mail", "x", 100);
    const refused = mail(layout, ["send", rel], { expectCode: 2 });
    expect(refused.stderr).toContain("only accepts drafts");

    layout.ensureAccount("a@gmail.com");
    fs.writeFileSync(path.join(layout.room, "body.txt"), "x");
    const draftRel = mail(layout, [
      "compose",
      "a@gmail.com",
      "to@example.com",
      "s",
      "body.txt",
    ]).stdout.trim();
    fs.writeFileSync(path.join(layout.room, "loose.pdf"), "pdf");
    const badAtt = mail(layout, ["send", draftRel, "--attach", "loose.pdf"], {
      expectCode: 2,
    });
    expect(badAtt.stderr).toContain("attachments must live under");
  });

  it("archives by path and unarchives by id (metadata-only rows included)", () => {
    const layout = makeLayout();
    const { rel } = seedMessage(layout, "zero inbox", "x", 100);
    const out = mail(layout, ["archive", rel]).stdout;
    expect(out).toContain("ARCHIVE queued:");
    const metaSha = seedMeta(layout, "old archived", 50);
    const out2 = mail(layout, ["unarchive", metaSha]).stdout;
    expect(out2).toContain("UNARCHIVE queued:");

    const requests = fs
      .readFileSync(path.join(layout.room, ".folder-request.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(requests).toHaveLength(2);
    expect(requests[0].op).toBe("archive");
    expect(requests[0].message_id).toBe("<zero-inbox@x>");
    expect(requests[1].op).toBe("unarchive");
    expect(requests[1].message_id).toBe("<old-archived@old>");
    expect(requests[1].path).toBe("");
    expect(requests[1].sha).toBe(metaSha);
  });

  it("archive by id refuses when the index lacks a Message-ID", () => {
    const layout = makeLayout();
    const sha = seedMeta(layout, "no rfc id", 50, {
      rfcMessageId: undefined,
      folder: "INBOX",
      labels: ["INBOX"],
    });
    const out = mail(layout, ["archive", sha], { expectCode: 1 });
    expect(out.stderr).toContain("no Message-ID");
  });

  it("tags by path and by id, reading pending and folded tags", () => {
    const layout = makeLayout();
    const { rel } = seedMessage(layout, "taggable", "x", 100);
    const metaSha = seedMeta(layout, "meta tag", 50);
    mail(layout, ["tag", rel, "urgent"]);
    mail(layout, ["tag", metaSha, "later"]);
    expect(mail(layout, ["tags", rel]).stdout.trim()).toBe("urgent");
    expect(mail(layout, ["tags", metaSha]).stdout.trim()).toBe("later");
  });

  it("tags and untags, reading pending and folded tags", () => {
    const layout = makeLayout();
    const { rel } = seedMessage(layout, "taggable", "x", 100);
    expect(mail(layout, ["tags", rel]).stdout.trim()).toBe("");

    mail(layout, ["tag", rel, "urgent"]);
    expect(mail(layout, ["tags", rel]).stdout.trim()).toBe("urgent");

    const out = mail(layout, ["untag", rel, "urgent"]);
    expect(out.code).toBe(0);
    expect(mail(layout, ["tags", rel]).stdout.trim()).toBe("");
  });

  it("reports status including backfill progress", () => {
    const layout = makeLayout();
    fs.writeFileSync(
      path.join(layout.room, ".broker-status.json"),
      JSON.stringify({
        ts: new Date().toISOString(),
        mode: "boundary",
        dry_run: true,
        accounts: ["a@gmail.com"],
        own_addresses: ["a@gmail.com"],
        allowed_recipient_domains: [],
        max_sends_per_hour: 5,
        pending_intents: 0,
        auth: { "a@gmail.com": "ok" },
        auth_urls: {},
      }),
    );
    const index = makeIndex(layout);
    index.putSyncState({
      account: "a@gmail.com",
      mailbox: "[Gmail]/All Mail",
      uidValidity: 42,
      lastUid: 900,
      lowUid: 400,
      cursor: null,
      status: "in_progress",
      totalExpected: 18767,
    });
    index.close();

    const out = mail(layout, ["status"]).stdout;
    expect(out).toContain("broker: BOUNDARY MODE");
    expect(out).toContain("dry_run: true");
    expect(out).toContain("auth a@gmail.com: ok");
    expect(out).toContain("backfill a@gmail.com");
    expect(out).toContain("in progress");
    expect(out).toContain("18767");
  });

  it("jails path arguments to the room", () => {
    const layout = makeLayout();
    const outside = mail(layout, ["read", "../broker/config.json"], {
      expectCode: 2,
    });
    expect(outside.stderr).toContain("outside the room");
  });

  it("exits 3 for missing files and unknown ids", () => {
    const layout = makeLayout();
    const missing = mail(layout, ["read", "nope.eml"], { expectCode: 3 });
    expect(missing.stderr).toContain("not found");
  });

  it("queues login and account requests", () => {
    const layout = makeLayout();
    const login = mail(layout, ["login", "new@gmail.com"]).stdout;
    expect(login).toContain("LOGIN requested for new@gmail.com");
    const request = JSON.parse(
      fs.readFileSync(path.join(layout.room, ".login-request.json"), "utf-8"),
    );
    expect(request.address).toBe("new@gmail.com");

    const account = mail(layout, ["account", "add", "gmail", "x@gmail.com"]);
    expect(account.stdout).toContain("ACCOUNT requested: gmail x@gmail.com");
  });

  it("search still answers when the store has no FTS index", () => {
    const layout = makeLayout();
    process.env.MESSAGEOPERATOR_DISABLE_FTS5 = "1";
    try {
      // broker built the store without FTS (limited-runtime scenario)
      seedMessage(layout, "invoice open", "please send money", 100);
      seedMeta(layout, "ancient invoice", 50);
      seedMessage(layout, "apple pie", "tasty dessert", 200);
      seedMessage(layout, "banana split", "sweet dessert", 300);
    } finally {
      delete process.env.MESSAGEOPERATOR_DISABLE_FTS5;
    }
    const out = mail(layout, ["search", "invoi -paid"]).stdout;
    expect(out).toContain("invoice open");
    expect(out).toContain("ancient invoice");
    expect(mail(layout, ["search", "money"]).stdout).toContain("invoice open");
    expect(mail(layout, ["search", "nothing-matches"]).stdout).toContain(
      "TOTAL 0",
    );
    const orOut = mail(layout, ["search", "apple OR banana"]).stdout;
    expect(orOut).toContain("apple pie");
    expect(orOut).toContain("banana split");
  });
});
