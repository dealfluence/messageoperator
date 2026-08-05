import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

import { Layout, sha12 } from "../src/layout.js";
import { Ledger } from "../src/ledger.js";
import { Index } from "../src/state.js";
import type { Config } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/config.js";

export function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "messageoperator-test-"));
}

export function makeLayout(): Layout {
  const layout = new Layout(tmpHome());
  layout.ensureRoom();
  layout.ensureBroker();
  return layout;
}

export function makeConfig(partial: Partial<Config> = {}): Config {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...partial,
    policy: {
      ...structuredClone(DEFAULT_CONFIG.policy),
      ...(partial.policy ?? {}),
    },
  };
}

export function writeConfigFile(layout: Layout, cfg: Config): void {
  fs.writeFileSync(layout.configPath, JSON.stringify(cfg, null, 2));
}

export function makeIndex(layout: Layout): Index {
  return new Index(layout.dbPath, { legacyJson: layout.indexPath });
}

export function makeLedger(layout: Layout): Ledger {
  return new Ledger(layout.ledgerPath);
}

export function sampleEml(
  opts: {
    from?: string;
    to?: string;
    subject?: string;
    body?: string;
    date?: string;
    messageId?: string;
    extraHeaders?: string[];
  } = {},
): Buffer {
  const lines = [
    `From: ${opts.from ?? "Alice <alice@example.com>"}`,
    `To: ${opts.to ?? "bob@example.com"}`,
    `Subject: ${opts.subject ?? "Hello"}`,
    `Date: ${opts.date ?? "Mon, 06 Jul 2026 10:00:00 +0000"}`,
    `Message-ID: ${opts.messageId ?? "<msg-1@example.com>"}`,
    ...(opts.extraHeaders ?? []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    opts.body ?? "Hi there.",
    "",
  ];
  return Buffer.from(lines.join("\r\n"), "utf-8");
}

/**
 * A minimal but valid .docx: one run per paragraph. Small enough to build
 * inline, real enough for @adeu/core's extractor and redline engine.
 */
export function sampleDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`)
    .join("");
  const files = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:body>${body}</w:body></w:document>`,
    ),
  };
  return Buffer.from(zipSync(files));
}

/** A minimal one-page PDF with `text` drawn in Helvetica. */
export function samplePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ` +
      `/Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  out +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Attach `files` to a sampleEml-style message as base64 MIME parts. */
export function emlWithAttachments(
  files: Array<{ filename: string; content: Buffer }>,
  opts: { subject?: string; body?: string } = {},
): Buffer {
  const boundary = "b0undary";
  const lines = [
    "From: alice@example.com",
    "To: bob@example.com",
    `Subject: ${opts.subject ?? "with attachments"}`,
    "Date: Mon, 06 Jul 2026 10:00:00 +0000",
    "Message-ID: <att-1@example.com>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    opts.body ?? "See attached.",
  ];
  for (const f of files) {
    lines.push(
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${f.filename}"`,
      "",
      f.content.toString("base64"),
    );
  }
  lines.push(`--${boundary}--`, "");
  return Buffer.from(lines.join("\r\n"), "utf-8");
}

/** Put a draft + its intent into an account's DraftBox, as `mail draft` would. */
export function queueDraftUpload(
  layout: Layout,
  address: string,
  raw: Buffer,
  opts: { shaOverride?: string } = {},
): { emlPath: string; intentPath: string } {
  layout.ensureAccount(address);
  const boxNew = path.join(layout.accounts, address, "mail", "DraftBox", "new");
  fs.mkdirSync(boxNew, { recursive: true });
  const name = `${Math.floor(Date.now() / 1000)}.${sha12(raw)}.eml`;
  const emlPath = path.join(boxNew, name);
  fs.writeFileSync(emlPath, raw);
  const intentPath = emlPath + ".draft.json";
  fs.writeFileSync(
    intentPath,
    JSON.stringify({
      account: address,
      op: "upload",
      sha256_12: opts.shaOverride ?? sha12(raw),
      ts: new Date().toISOString(),
    }),
  );
  return { emlPath, intentPath };
}

/** Put a delete intent into an account's DraftBox, as `mail draft-delete` would. */
export function queueDraftDelete(
  layout: Layout,
  address: string,
  messageId: string,
): { intentPath: string } {
  layout.ensureAccount(address);
  const boxNew = path.join(layout.accounts, address, "mail", "DraftBox", "new");
  fs.mkdirSync(boxNew, { recursive: true });
  const name = `${Math.floor(Date.now() / 1000)}.${sha12(messageId)}.delete.draft.json`;
  const intentPath = path.join(boxNew, name);
  fs.writeFileSync(
    intentPath,
    JSON.stringify({
      account: address,
      op: "delete",
      message_id: messageId,
      ts: new Date().toISOString(),
    }),
  );
  return { intentPath };
}

/** Put a draft + its intent into an account's Outbox, as `mail send` would. */
export function queueSend(
  layout: Layout,
  address: string,
  raw: Buffer,
  opts: { attachments?: string[]; shaOverride?: string } = {},
): { draftPath: string; intentPath: string } {
  layout.ensureAccount(address);
  const outboxNew = path.join(
    layout.accounts,
    address,
    "mail",
    "Outbox",
    "new",
  );
  const name = `${Math.floor(Date.now() / 1000)}.${sha12(raw)}.eml`;
  const draftPath = path.join(outboxNew, name);
  fs.writeFileSync(draftPath, raw);
  const intentPath = draftPath + ".intent.json";
  fs.writeFileSync(
    intentPath,
    JSON.stringify({
      account: address,
      sha256_12: opts.shaOverride ?? sha12(raw),
      attachments: opts.attachments ?? [],
      ts: new Date().toISOString(),
    }),
  );
  return { draftPath, intentPath };
}
