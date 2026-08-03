import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sha12 } from "../src/layout.js";
import { sanitizeFilename, storeMessage } from "../src/store.js";
import {
  emlWithAttachments,
  makeIndex,
  makeLayout,
  makeLedger,
  sampleDocx,
  sampleEml,
  samplePdf,
} from "./helpers.js";

const SAMPLE_XLSX = fileURLToPath(
  new URL("./fixtures/sample.xlsx", import.meta.url),
);

/** Open a written tabular sidecar read-only (same builtin the source uses). */
function openSidecar(dbPath: string) {
  const mod = process.getBuiltinModule?.("node:sqlite");
  if (!mod) throw new Error("node:sqlite unavailable");
  return new mod.DatabaseSync(dbPath, { readOnly: true });
}

describe("sanitizeFilename", () => {
  it("strips traversal and illegal characters, keeps unicode", () => {
    expect(sanitizeFilename("../../evil.txt")).toBe("evil.txt");
    expect(sanitizeFilename("..\\..\\evil.txt")).toBe("evil.txt");
    expect(sanitizeFilename('inv<oi>ce:"2026".pdf')).toBe(
      "inv_oi_ce__2026_.pdf",
    );
    expect(sanitizeFilename("räport.pdf")).toBe("räport.pdf");
    expect(sanitizeFilename("con.txt")).toBe("_con.txt");
    expect(sanitizeFilename("")).toBe("attachment");
  });
});

describe("storeMessage", () => {
  it("stores one message with meta sidecar and index row", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const raw = sampleEml({
      subject: "Quarterly report",
      body: "Numbers inside.",
    });
    const dest = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    expect(dest).not.toBeNull();
    const sha = sha12(raw);
    expect(path.basename(dest!)).toMatch(new RegExp(`^\\d+\\.${sha}\\.eml$`));
    expect(fs.readFileSync(dest!)).toEqual(raw);

    const meta = fs.readFileSync(dest + ".meta", "utf-8");
    expect(meta).toContain(`X-Mailroom-Sha: ${sha}`);
    expect(meta).toContain("Numbers inside.");

    expect(index.hasSha(sha)).toBe(true);
    const row = index.allMessages()[0]!;
    expect(row.subject).toBe("Quarterly report");
    expect(row.folder).toBe("INBOX");
    expect(row.epoch).toBe(
      Math.floor(Date.parse("2026-07-06T10:00:00Z") / 1000),
    );

    const ops = ledger.readAll().map((r) => r.op);
    expect(ops).toContain("sync_message");
  });

  it("records provider id, labels, and the RFC Message-ID on the row", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const raw = sampleEml({ messageId: "<orig-9@example.com>" });
    await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
      providerMsgId: "g-123",
      labels: ["INBOX", "IMPORTANT"],
    });
    const row = index.allMessages()[0]!;
    expect(row.gmailId).toBe("g-123");
    expect(row.labels).toEqual(["INBOX", "IMPORTANT"]);
    expect(row.rfcMessageId).toBe("<orig-9@example.com>");
    expect(row.metaOnly).toBeUndefined();
    expect(index.hasProviderMsg("a@example.com", "g-123")).toBe(true);
    expect(index.hasRfcMessageId("a@example.com", "<orig-9@example.com>")).toBe(
      true,
    );
  });

  it("supersedes a metadata-only stand-in when the body arrives", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    index.insertMessage({
      sha: "gm:g9",
      account: "a@example.com",
      folder: "Archive",
      filename: "",
      path: "",
      date: "",
      epoch: 5,
      from: "alice@example.com",
      to: "me@example.com",
      subject: "was archived",
      body: "",
      labels: [],
      gmailId: "g9",
      metaOnly: true,
    });
    const raw = sampleEml({ subject: "was archived" });
    await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
      providerMsgId: "g9",
      labels: ["INBOX"],
    });
    const rows = index.allMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metaOnly).toBeUndefined();
    expect(rows[0]?.gmailId).toBe("g9");
    expect(rows[0]?.path).toContain("INBOX/cur/");
  });

  it("dedups by content sha", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const raw = sampleEml();
    const first = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    const second = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("extracts attachments with collision-safe names", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const boundary = "b0undary";
    const payload = Buffer.from("PDFDATA").toString("base64");
    const raw = Buffer.from(
      [
        "From: a@example.com",
        "To: b@example.com",
        "Subject: with attachment",
        "Date: Mon, 06 Jul 2026 10:00:00 +0000",
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "See attached.",
        `--${boundary}`,
        "Content-Type: application/pdf",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="../report.pdf"',
        "",
        payload,
        `--${boundary}--`,
        "",
      ].join("\r\n"),
      "utf-8",
    );
    const dest = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    const sha = sha12(raw);
    const attDir = path.join(layout.attachments, sha);
    expect(fs.readdirSync(attDir)).toEqual(["report.pdf"]);
    expect(fs.readFileSync(path.join(attDir, "report.pdf")).toString()).toBe(
      "PDFDATA",
    );
    const meta = fs.readFileSync(dest + ".meta", "utf-8");
    expect(meta).toContain(
      `X-Mailroom-Attachments: attachments/${sha}/report.pdf`,
    );
  });

  it("extracts markdown views for docx and pdf attachments", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const raw = emlWithAttachments([
      { filename: "contract.docx", content: sampleDocx(["Hello contract."]) },
      { filename: "invoice.pdf", content: samplePdf("Amount due 100") },
      { filename: "data.bin", content: Buffer.from("binary") },
    ]);
    const dest = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    const sha = sha12(raw);
    const attDir = path.join(layout.attachments, sha);

    const docxView = fs.readFileSync(
      path.join(attDir, "contract.docx.md"),
      "utf-8",
    );
    expect(docxView).toBe("Hello contract.\n");
    const pdfView = fs.readFileSync(
      path.join(attDir, "invoice.pdf.md"),
      "utf-8",
    );
    expect(pdfView).toContain("Amount due 100");
    expect(fs.existsSync(path.join(attDir, "data.bin.md"))).toBe(false);

    const meta = fs.readFileSync(dest + ".meta", "utf-8");
    expect(meta).toContain(
      `X-Mailroom-Attachments: attachments/${sha}/contract.docx`,
    );
    expect(meta).toContain(
      `X-Mailroom-Attachment-Views: attachments/${sha}/contract.docx.md`,
    );
    expect(meta).toContain(
      `X-Mailroom-Attachment-Views: attachments/${sha}/invoice.pdf.md`,
    );
    expect(meta).not.toContain(
      `X-Mailroom-Attachment-Views: attachments/${sha}/data.bin.md`,
    );
  });

  /**
   * QA 2026-07-24, BUG-5 (low): an image-only PDF (a scan) parses fine and
   * yields no text, so the view written beside it is asViewFile("") — a 1-byte
   * file holding just a newline. An agent that cats it gets nothing and no
   * explanation, and cannot tell "this scan has no text layer" from "the view
   * is broken" or "extraction never ran".
   *
   * Three such views exist in the live room, two of them scanned Finnish
   * documents (Pöytäkirja…, sopimus…) — the ICP's normal paperwork, not an edge
   * case. The view must say why it is empty; the malformed-document case below
   * is different on purpose (no view file at all, because parsing failed).
   */
  it("marks a text-less PDF view instead of writing an empty one (QA 2026-07-24 BUG-5)", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    // a valid, parseable PDF whose only text operator draws nothing: what a
    // scanner produces when there is no OCR layer
    const raw = emlWithAttachments([
      { filename: "scan.pdf", content: samplePdf("") },
    ]);
    const dest = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    const sha = sha12(raw);
    const viewPath = path.join(layout.attachments, sha, "scan.pdf.md");

    // the view is still offered to the agent (this part works today)
    const meta = fs.readFileSync(dest + ".meta", "utf-8");
    expect(meta).toContain(
      `X-Mailroom-Attachment-Views: attachments/${sha}/scan.pdf.md`,
    );

    const view = fs.readFileSync(viewPath, "utf-8");
    expect(
      view.trim(),
      "the view is an empty file, not an explanation",
    ).not.toBe("");
    // self-describing: names the reason, so the dead end needs no follow-up
    expect(view).toMatch(/no (extractable )?text|image[- ]only|scan/i);
  });

  it("survives malformed documents: binary stored, no view, no crash", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const raw = emlWithAttachments([
      { filename: "broken.docx", content: Buffer.from("not a zip at all") },
      { filename: "broken.pdf", content: Buffer.from("not a pdf either") },
    ]);
    const dest = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    expect(dest).not.toBeNull();
    const sha = sha12(raw);
    const attDir = path.join(layout.attachments, sha);
    expect(fs.readdirSync(attDir).sort()).toEqual([
      "broken.docx",
      "broken.pdf",
    ]);
    const meta = fs.readFileSync(dest + ".meta", "utf-8");
    expect(meta).toContain(
      `X-Mailroom-Attachments: attachments/${sha}/broken.docx`,
    );
    expect(meta).not.toContain("X-Mailroom-Attachment-Views:");
  });

  it("never overwrites a real attachment with a generated view", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    // the mail legitimately attaches BOTH report.docx and report.docx.md;
    // the attached .md must win over the generated view
    const raw = emlWithAttachments([
      { filename: "report.docx.md", content: Buffer.from("attached notes") },
      { filename: "report.docx", content: sampleDocx(["Doc text."]) },
    ]);
    await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    const sha = sha12(raw);
    const attDir = path.join(layout.attachments, sha);
    expect(fs.readFileSync(path.join(attDir, "report.docx.md"), "utf-8")).toBe(
      "attached notes",
    );
  });

  it("produces a table view + sidecar + meta lines for a spreadsheet", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const raw = emlWithAttachments([
      { filename: "employees.xlsx", content: fs.readFileSync(SAMPLE_XLSX) },
    ]);
    const dest = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    const sha = sha12(raw);
    const attDir = path.join(layout.attachments, sha);

    // the readable .md view exists and reads as a table
    const view = fs.readFileSync(
      path.join(attDir, "employees.xlsx.md"),
      "utf-8",
    );
    expect(view).toContain("EmployeeID");
    expect(view).toContain("|"); // markdown table pipes

    // the structured sidecar exists with the right schema + content
    const dbPath = path.join(attDir, "employees.xlsx.tabular.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = openSidecar(dbPath);
    try {
      const src = db
        .prepare("SELECT value FROM meta WHERE key='source_sha'")
        .get() as { value: string };
      expect(src.value).toBe(sha); // sidecar keyed to the attachment folder sha
      const sheets = db.prepare("SELECT COUNT(*) c FROM sheets").get() as {
        c: number;
      };
      expect(sheets.c).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }

    // both meta lines are present
    const meta = fs.readFileSync(dest + ".meta", "utf-8");
    expect(meta).toContain(
      `X-Mailroom-Attachment-Views: attachments/${sha}/employees.xlsx.md`,
    );
    expect(meta).toContain(
      `X-Mailroom-Attachment-Tables: attachments/${sha}/employees.xlsx.tabular.db`,
    );
  });

  it("produces a table view + sidecar for a CSV via the stdlib path", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const csv = "name,qty\napples,3\npears,5\n";
    const raw = emlWithAttachments([
      { filename: "order.csv", content: Buffer.from(csv, "utf-8") },
    ]);
    const dest = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    const sha = sha12(raw);
    const attDir = path.join(layout.attachments, sha);
    expect(fs.existsSync(path.join(attDir, "order.csv.md"))).toBe(true);
    expect(fs.existsSync(path.join(attDir, "order.csv.tabular.db"))).toBe(true);
    const meta = fs.readFileSync(dest + ".meta", "utf-8");
    expect(meta).toContain(
      `X-Mailroom-Attachment-Tables: attachments/${sha}/order.csv.tabular.db`,
    );
  });

  it("isolates a malformed workbook: raw stored, no view/sidecar, no crash", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const raw = emlWithAttachments([
      {
        filename: "broken.xlsx",
        content: Buffer.from("PK\x03\x04 not a real xlsx"),
      },
    ]);
    const dest = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
    });
    expect(dest).not.toBeNull();
    const sha = sha12(raw);
    const attDir = path.join(layout.attachments, sha);
    // the raw attachment is stored...
    expect(fs.existsSync(path.join(attDir, "broken.xlsx"))).toBe(true);
    // ...but no view and no sidecar were produced
    expect(fs.existsSync(path.join(attDir, "broken.xlsx.md"))).toBe(false);
    expect(fs.existsSync(path.join(attDir, "broken.xlsx.tabular.db"))).toBe(
      false,
    );
    const meta = fs.readFileSync(dest + ".meta", "utf-8");
    expect(meta).toContain(
      `X-Mailroom-Attachments: attachments/${sha}/broken.xlsx`,
    );
    expect(meta).not.toContain("X-Mailroom-Attachment-Tables:");
  });

  it("adds explained paths for the audit", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const explained = new Set<string>();
    const raw = sampleEml();
    const dest = await storeMessage(layout, index, ledger, {
      account: "a@example.com",
      folder: "INBOX",
      raw,
      explained,
    });
    expect(explained.has(layout.rel(dest!))).toBe(true);
    expect(explained.has(layout.rel(dest + ".meta"))).toBe(true);
  });
});
