import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";

import {
  finalMime,
  processDraftBox,
  processOutboxes,
  type Deliverers,
  type DraftDeleters,
  type DraftUploaders,
} from "../src/intents.js";
import { sha12 } from "../src/layout.js";
import {
  makeConfig,
  makeIndex,
  makeLayout,
  makeLedger,
  queueDraftDelete,
  queueDraftUpload,
  queueSend,
  sampleEml,
} from "./helpers.js";

const GMAIL_ACCT = { provider: "gmail" as const, address: "a@gmail.com" };
const MS_ACCT = {
  provider: "microsoft" as const,
  address: "m@outlook.com",
  client_id: "cid",
};

function noDeliverers(calls: string[] = []): Deliverers {
  return {
    gmail: async () => {
      calls.push("gmail");
      return "<mid>";
    },
    microsoft: async () => {
      calls.push("microsoft");
      return "<mid>";
    },
  };
}

function cfgWithAccounts(dryRun: boolean) {
  return makeConfig({ dry_run: dryRun, accounts: [GMAIL_ACCT, MS_ACCT] });
}

describe("intent processing", () => {
  it("simulates a valid send under dry_run and moves the draft to Sent/", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const raw = sampleEml({ to: "m@outlook.com" }); // own address: always allowed
    const { draftPath } = queueSend(layout, "a@gmail.com", raw);
    const calls: string[] = [];

    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(calls),
    );

    expect(calls).toEqual([]); // dry_run: no network deliverer touched
    const ops = ledger.readAll().map((r) => r.op);
    expect(ops).toContain("send_simulated");
    expect(fs.existsSync(draftPath)).toBe(false);
    const sent = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Sent",
      "cur",
    );
    expect(fs.readdirSync(sent)).toHaveLength(1);
  });

  it("writes the attachment-folded MIME into the Sent copy (not the bare draft)", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    // an attachment that lives under attachments/ (passes the send policy)
    const attDir = path.join(layout.attachments, "abc");
    fs.mkdirSync(attDir, { recursive: true });
    fs.writeFileSync(path.join(attDir, "doc.pdf"), "PDFDATA");
    const raw = sampleEml({ to: "m@outlook.com", body: "See attachment." });
    queueSend(layout, "a@gmail.com", raw, {
      attachments: ["attachments/abc/doc.pdf"],
    });

    // dry_run: the Sent copy must STILL be the folded MIME (the bug was that
    // the simulated path stored the bare draft with no attachment)
    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
    );

    const sentDir = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Sent",
      "cur",
    );
    const files = fs.readdirSync(sentDir);
    expect(files).toHaveLength(1);
    const sent = fs
      .readFileSync(path.join(sentDir, files[0]!))
      .toString("latin1");
    expect(sent).toContain("Content-Type: multipart/mixed");
    expect(sent).toContain('filename="doc.pdf"');
    expect(sent).toContain(Buffer.from("PDFDATA").toString("base64"));
    // and it is NOT just the untouched draft
    expect(sent).not.toEqual(raw.toString("latin1"));
  });

  it("keeps a no-attachment Sent copy byte-identical to the draft", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const raw = sampleEml({ to: "m@outlook.com" });
    queueSend(layout, "a@gmail.com", raw);

    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
    );

    const sentDir = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Sent",
      "cur",
    );
    const files = fs.readdirSync(sentDir);
    expect(files).toHaveLength(1);
    const sent = fs.readFileSync(path.join(sentDir, files[0]!));
    // finalMime returns the raw bytes untouched when there are no attachments,
    // so the Sent copy must equal the original draft exactly (regression guard)
    expect(sent.equals(raw)).toBe(true);
  });
  it("delivers through the account's provider channel when dry_run is off", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const calls: string[] = [];
    queueSend(
      layout,
      "m@outlook.com",
      sampleEml({ from: "m@outlook.com", to: "a@gmail.com" }),
    );
    // rewrite intent account to the MS address (queueSend uses dir name)
    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(false),
      new Set(),
      noDeliverers(calls),
    );

    expect(calls).toEqual(["microsoft"]);
    const executed = ledger.readAll().find((r) => r.op === "send_executed");
    expect(executed).toBeDefined();
    expect((executed!.details as any).channel).toBe("microsoft");
  });

  it("rejects a sha mismatch and returns the draft with a .rejected.txt", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const raw = sampleEml({ to: "m@outlook.com" });
    const { draftPath } = queueSend(layout, "a@gmail.com", raw, {
      shaOverride: "wrong0000000",
    });

    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
    );

    const rejected = ledger.readAll().find((r) => r.op === "send_rejected");
    expect((rejected!.details as any).reason).toBe("sha_mismatch");
    const drafts = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Drafts",
      "cur",
    );
    const names = fs.readdirSync(drafts);
    expect(names).toContain(path.basename(draftPath));
    expect(names.some((n) => n.endsWith(".rejected.txt"))).toBe(true);
    expect(fs.existsSync(draftPath)).toBe(false);
  });

  it("rejects recipients outside the allowlist", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    queueSend(
      layout,
      "a@gmail.com",
      sampleEml({ to: "stranger@elsewhere.com" }),
    );

    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
    );

    const rejected = ledger.readAll().find((r) => r.op === "send_rejected");
    expect((rejected!.details as any).reason).toBe("recipient_not_allowed");
  });

  it("restricts own-address recipients to the authenticated set when given", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    // m@outlook.com is configured but NOT in the authenticated set
    queueSend(layout, "a@gmail.com", sampleEml({ to: "m@outlook.com" }));
    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
      new Set(["a@gmail.com"]),
    );
    const rejected = ledger.readAll().find((r) => r.op === "send_rejected");
    expect((rejected!.details as any).reason).toBe("recipient_not_allowed");

    // the authenticated address itself stays allowed
    queueSend(
      layout,
      "a@gmail.com",
      sampleEml({ to: "a@gmail.com", subject: "self" }),
    );
    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
      new Set(["a@gmail.com"]),
    );
    expect(ledger.readAll().map((r) => r.op)).toContain("send_simulated");
  });

  it("allows recipients in an allowed domain", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const cfg = cfgWithAccounts(true);
    cfg.policy.allowed_recipient_domains = ["elsewhere.com"];
    queueSend(
      layout,
      "a@gmail.com",
      sampleEml({ to: "stranger@elsewhere.com" }),
    );

    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfg,
      new Set(),
      noDeliverers(),
    );

    expect(ledger.readAll().map((r) => r.op)).toContain("send_simulated");
  });

  it("refuses Resent-* headers outright", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    queueSend(
      layout,
      "a@gmail.com",
      sampleEml({
        to: "m@outlook.com",
        extraHeaders: ["Resent-To: sneaky@elsewhere.com"],
      }),
    );

    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
    );

    const rejected = ledger.readAll().find((r) => r.op === "send_rejected");
    expect((rejected!.details as any).reason).toBe(
      "resent_headers_not_allowed",
    );
  });

  it("enforces the hourly rate limit across executed and simulated sends", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const cfg = cfgWithAccounts(true);
    cfg.policy.max_sends_per_hour = 2;
    for (let i = 0; i < 2; i++) ledger.append("send_simulated", {});
    queueSend(layout, "a@gmail.com", sampleEml({ to: "m@outlook.com" }));

    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfg,
      new Set(),
      noDeliverers(),
    );

    const rejected = ledger.readAll().find((r) => r.op === "send_rejected");
    expect((rejected!.details as any).reason).toBe("rate_limited");
  });

  it("rejects attachments outside attachments/ and missing files", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    queueSend(layout, "a@gmail.com", sampleEml({ to: "m@outlook.com" }), {
      attachments: ["bin/mail"],
    });
    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
    );
    const rejected = ledger.readAll().find((r) => r.op === "send_rejected");
    expect((rejected!.details as any).reason).toBe(
      "attachment_outside_attachments_dir",
    );

    queueSend(
      layout,
      "a@gmail.com",
      sampleEml({ to: "m@outlook.com", subject: "2" }),
      {
        attachments: ["attachments/nope/gone.pdf"],
      },
    );
    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
    );
    const rejections = ledger.readAll().filter((r) => r.op === "send_rejected");
    expect((rejections.at(-1)!.details as any).reason).toBe(
      "attachment_missing",
    );
  });

  it("unclaims the intent when delivery fails, for retry next cycle", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const { draftPath, intentPath } = queueSend(
      layout,
      "a@gmail.com",
      sampleEml({ to: "m@outlook.com" }),
    );
    const failing: Deliverers = {
      gmail: async () => {
        throw new Error("smtp down");
      },
      microsoft: async () => "<mid>",
    };

    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(false),
      new Set(),
      failing,
    );

    // delivery_error → rejected; draft returned, intent consumed
    const rejected = ledger.readAll().find((r) => r.op === "send_rejected");
    expect((rejected!.details as any).reason).toBe("delivery_error");
    expect(fs.existsSync(intentPath)).toBe(false);
    expect(fs.existsSync(draftPath)).toBe(false);
    const drafts = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Drafts",
      "cur",
    );
    expect(fs.readdirSync(drafts)).toContain(path.basename(draftPath));
  });

  it("finishes an interrupted send whose delivery was already ledgered", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const raw = sampleEml({ to: "m@outlook.com" });
    const { draftPath, intentPath } = queueSend(layout, "a@gmail.com", raw);
    const claimed = draftPath + ".intent.sending";
    fs.renameSync(intentPath, claimed);
    ledger.append("send_executed", {}, { sha: sha12(raw) });

    const calls: string[] = [];
    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(false),
      new Set(),
      noDeliverers(calls),
    );

    expect(calls).toEqual([]); // NOT re-sent
    expect(fs.existsSync(claimed)).toBe(false);
    const sent = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Sent",
      "cur",
    );
    expect(fs.readdirSync(sent)).toContain(path.basename(draftPath));
  });

  it("re-queues a claimed intent whose delivery never happened", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const { draftPath, intentPath } = queueSend(
      layout,
      "a@gmail.com",
      sampleEml({ to: "m@outlook.com" }),
    );
    fs.renameSync(intentPath, draftPath + ".intent.sending");

    const calls: string[] = [];
    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(false),
      new Set(),
      noDeliverers(calls),
    );

    // recovered to .intent.json, then processed in the same cycle
    expect(calls).toEqual(["gmail"]);
    expect(ledger.readAll().map((r) => r.op)).toContain("send_executed");
  });

  it("returns an orphan Outbox draft after the grace period", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    layout.ensureAccount("a@gmail.com");
    const outboxNew = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Outbox",
      "new",
    );
    const orphan = path.join(outboxNew, "123.abc.eml");
    fs.writeFileSync(orphan, sampleEml());
    const old = (Date.now() - 3600_000) / 1000;
    fs.utimesSync(orphan, old, old);

    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
    );

    const rejected = ledger.readAll().find((r) => r.op === "send_rejected");
    expect((rejected!.details as any).reason).toBe("intent_missing");
    expect(fs.existsSync(orphan)).toBe(false);
    const drafts = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Drafts",
      "cur",
    );
    expect(fs.readdirSync(drafts)).toContain("123.abc.eml");
  });

  it("rejects an intent for an unknown account", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    queueSend(layout, "nobody@nowhere.com", sampleEml({ to: "m@outlook.com" }));

    await processOutboxes(
      layout,
      makeIndex(layout),
      ledger,
      cfgWithAccounts(true),
      new Set(),
      noDeliverers(),
    );

    const rejected = ledger.readAll().find((r) => r.op === "send_rejected");
    expect((rejected!.details as any).reason).toBe("unknown_account");
  });
});

describe("finalMime", () => {
  it("passes a draft without attachments through untouched", () => {
    const layout = makeLayout();
    const raw = sampleEml();
    expect(finalMime(layout, raw, [])).toEqual(raw);
  });

  it("wraps body and attachments into multipart/mixed", () => {
    const layout = makeLayout();
    const attDir = path.join(layout.attachments, "abc");
    fs.mkdirSync(attDir, { recursive: true });
    fs.writeFileSync(path.join(attDir, "doc.pdf"), "PDFDATA");
    const raw = sampleEml({ body: "See attachment." });

    const mime = finalMime(layout, raw, ["attachments/abc/doc.pdf"]).toString(
      "latin1",
    );
    expect(mime).toContain("Content-Type: multipart/mixed");
    expect(mime).toContain("See attachment.");
    expect(mime).toContain(
      'Content-Disposition: attachment; filename="doc.pdf"',
    );
    expect(mime).toContain(Buffer.from("PDFDATA").toString("base64"));
    expect(mime).toContain("Subject: Hello");
  });
});

/**
 * QA 2026-07-24, BUG-1 (high): non-ASCII attachment filenames are corrupted on
 * send. finalMime() assembles the whole message as a JS string and encodes it
 * with "latin1", which truncates every UTF-16 code unit to its low byte: "Ä"
 * (U+00C4) ships as the single byte 0xC4, and "☃" (U+2603) becomes 0x03 — a raw
 * control character, irrecoverable. Nothing declares a charset either, so the
 * filename parameter is a raw 8-bit header field and every receiver has to
 * guess: Graph guessed UTF-8 and re-emitted the name as
 * `=?utf-8?B?...?=` over U+FFFD replacement chars.
 *
 * The bug is in finalMime, i.e. BEFORE the provider split, so it hits the Gmail
 * and Microsoft paths equally — verified against the Sent copy on disk, which
 * finishSend() writes byte-for-byte from finalMime's output.
 *
 * Either RFC 2231 (`filename*=UTF-8''...`) or an RFC 2047 encoded-word fixes
 * this; the assertions below deliberately pin the observable contract (7-bit
 * clean headers, exact name after a parser round-trip) rather than a mechanism.
 */
describe("finalMime non-ASCII attachment filenames (QA 2026-07-24 BUG-1)", () => {
  // the two fixtures the QA run actually sent: 2-byte and 3-byte UTF-8
  const TWO_BYTE = "torture,data ÄÖ.csv";
  const THREE_BYTE = "ääkkös tiedosto ☃.txt";
  const PAYLOAD = 'name,qty\n"a, b",3\n';

  function mimeWithAttachments(names: string[]): Buffer {
    const layout = makeLayout();
    const attDir = path.join(layout.attachments, "qa");
    fs.mkdirSync(attDir, { recursive: true });
    for (const name of names) {
      fs.writeFileSync(path.join(attDir, name), PAYLOAD);
    }
    return finalMime(
      layout,
      sampleEml({ body: "See attached." }),
      names.map((n) => `attachments/qa/${n}`),
    );
  }

  /** The Content-Type `name=` / Content-Disposition `filename=` header lines. */
  function nameHeaderLines(mime: Buffer): string[] {
    return mime
      .toString("latin1")
      .split("\r\n")
      .filter((l) => /^Content-(Type|Disposition):/i.test(l))
      .filter((l) => /(^|;)\s*(file)?name\*?=/i.test(l));
  }

  it("keeps every unicode codepoint of the filename (no code-unit truncation)", () => {
    const mime = mimeWithAttachments([THREE_BYTE]);
    // U+2603 currently lands as 0x03: the codepoint is destroyed in the room,
    // before any provider sees the message, so no receiver can recover it.
    expect(mime.includes(0x03)).toBe(false);
    // whatever encoding is chosen, the UTF-8 bytes of the name must be derivable
    expect(nameHeaderLines(mime).length).toBe(2);
  });

  it("emits 7-bit-clean name/filename header lines so receivers need not guess", () => {
    const mime = mimeWithAttachments([TWO_BYTE, THREE_BYTE]);
    const lines = nameHeaderLines(mime);
    expect(lines.length).toBe(4); // name= and filename= for both attachments
    for (const line of lines) {
      // RFC 5322 headers are US-ASCII; a non-ASCII filename must be encoded
      // (RFC 2231 filename*=UTF-8''… or an RFC 2047 encoded-word). Raw 8-bit
      // bytes here are what made Graph guess UTF-8 and produce U+FFFD.
      const offending = [...line].filter(
        (ch) => ch.codePointAt(0)! > 0x7f || ch.codePointAt(0)! < 0x20,
      );
      expect(offending, `non-ASCII byte in header line: ${line}`).toEqual([]);
    }
  });

  it("round-trips the exact filename through a MIME parser", async () => {
    const mime = mimeWithAttachments([TWO_BYTE, THREE_BYTE]);
    const parsed = await simpleParser(mime);
    expect(parsed.attachments.map((a) => a.filename)).toEqual([
      TWO_BYTE,
      THREE_BYTE,
    ]);
  });

  it("leaves the attachment payload byte-exact (guard for the filename fix)", async () => {
    // the QA run confirmed content survives today; a filename fix must not
    // regress the payload path (multiline quoted fields, commas, unicode)
    const mime = mimeWithAttachments([TWO_BYTE]);
    const parsed = await simpleParser(mime);
    expect(parsed.attachments[0]!.content.toString("utf-8")).toBe(PAYLOAD);
  });
});

function fakeUploaders(calls: string[] = []): DraftUploaders {
  return {
    gmail: async (_acct, mime) => {
      calls.push(`gmail:${mime.length}`);
      return "<mid>";
    },
    microsoft: async (_acct, mime) => {
      calls.push(`microsoft:${mime.length}`);
      return "<mid>";
    },
  };
}

function fakeDeleters(calls: string[] = []): DraftDeleters {
  return {
    gmail: async (_acct, mid) => {
      calls.push(`gmail:${mid}`);
      return "applied";
    },
    microsoft: async (_acct, mid) => {
      calls.push(`microsoft:${mid}`);
      return "applied";
    },
  };
}

describe("draft-box processing", () => {
  it("uploads a valid draft and clears the DraftBox", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const raw = sampleEml({ from: "a@gmail.com" });
    const { emlPath, intentPath } = queueDraftUpload(
      layout,
      "a@gmail.com",
      raw,
    );
    const calls: string[] = [];

    await processDraftBox(
      layout,
      ledger,
      cfgWithAccounts(false),
      new Set(),
      fakeUploaders(calls),
      fakeDeleters(),
    );

    expect(calls).toEqual([`gmail:${raw.length}`]);
    const ops = ledger.readAll().map((r) => r.op);
    expect(ops).toContain("draft_uploaded");
    expect(fs.existsSync(emlPath)).toBe(false);
    expect(fs.existsSync(intentPath)).toBe(false);
  });

  it("simulates the upload under dry_run and never touches the network", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const raw = sampleEml({ from: "a@gmail.com" });
    const { emlPath } = queueDraftUpload(layout, "a@gmail.com", raw);
    const calls: string[] = [];

    await processDraftBox(
      layout,
      ledger,
      cfgWithAccounts(true),
      new Set(),
      fakeUploaders(calls),
      fakeDeleters(),
    );

    expect(calls).toEqual([]);
    expect(ledger.readAll().map((r) => r.op)).toContain(
      "draft_upload_simulated",
    );
    expect(fs.existsSync(emlPath)).toBe(false);
  });

  it("rejects a tampered draft (sha mismatch) and returns it to Drafts", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const raw = sampleEml({ from: "a@gmail.com" });
    const { emlPath } = queueDraftUpload(layout, "a@gmail.com", raw, {
      shaOverride: "deadbeefdead",
    });
    const calls: string[] = [];

    await processDraftBox(
      layout,
      ledger,
      cfgWithAccounts(false),
      new Set(),
      fakeUploaders(calls),
      fakeDeleters(),
    );

    expect(calls).toEqual([]); // never uploaded
    expect(ledger.readAll().map((r) => r.op)).toContain("draft_rejected");
    expect(fs.existsSync(emlPath)).toBe(false); // moved out of DraftBox
    const drafts = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Drafts",
      "cur",
    );
    const returned = fs.readdirSync(drafts);
    expect(returned.some((n) => n.endsWith(".rejected.txt"))).toBe(true);
    expect(returned.some((n) => n.endsWith(".eml"))).toBe(true);
  });

  it("routes a delete intent to the right provider and clears the intent", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    const { intentPath } = queueDraftDelete(layout, "m@outlook.com", "<d@x>");
    const calls: string[] = [];

    await processDraftBox(
      layout,
      ledger,
      cfgWithAccounts(false),
      new Set(),
      fakeUploaders(),
      fakeDeleters(calls),
    );

    expect(calls).toEqual(["microsoft:<d@x>"]);
    expect(ledger.readAll().map((r) => r.op)).toContain("draft_deleted");
    expect(fs.existsSync(intentPath)).toBe(false);
  });

  it("simulates a delete under dry_run", async () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    queueDraftDelete(layout, "a@gmail.com", "<d@x>");
    const calls: string[] = [];

    await processDraftBox(
      layout,
      ledger,
      cfgWithAccounts(true),
      new Set(),
      fakeUploaders(),
      fakeDeleters(calls),
    );

    expect(calls).toEqual([]);
    expect(ledger.readAll().map((r) => r.op)).toContain(
      "draft_delete_simulated",
    );
  });
});
