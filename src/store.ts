/**
 * Turn raw RFC 2822 bytes into room state: Maildir file, .meta sidecar,
 * extracted attachments, and an index row.
 *
 * Filenames are `<epoch>.<sha12>.eml` with no Maildir `:2,` info suffix —
 * read-state and tags live in the index, not in filenames (a rule inherited
 * from the Windows POC that also keeps the two state trees compatible).
 */

import fs from "node:fs";
import path from "node:path";
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";

import type { Layout } from "./layout.js";
import { sha12 } from "./layout.js";
import { log } from "./log.js";
import {
  asViewFile,
  isTabularAttachment,
  markdownViewFor,
  tabularViewFor,
} from "./pack.js";
import { writeTabularSidecar } from "./tabular_store.js";
import type { Index, MessageRow } from "./state.js";
import type { Ledger } from "./ledger.js";

// only characters NTFS actually forbids (plus control chars); Unicode
// original filenames are preserved. Kept on macOS for state-tree parity.
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const RESERVED_STEMS = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Make an attachment filename safe and free of traversal, keeping the
 * original name as intact as possible.
 */
export function sanitizeFilename(name: string): string {
  let out = name.replace(/\\/g, "/");
  out = out.slice(out.lastIndexOf("/") + 1);
  out = out.replace(ILLEGAL_CHARS, "_").replace(/^[ .]+|[ .]+$/g, "");
  if (RESERVED_STEMS.has((out.split(".", 1)[0] ?? "").toLowerCase())) {
    out = "_" + out;
  }
  return out || "attachment";
}

/** Crude but safe HTML→text for meta sidecars and display. */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(p|br|div|tr|li|h[1-4]|blockquote)\b[^>]*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function extractBodyText(parsed: ParsedMail): string {
  if (parsed.text && parsed.text.trim()) return parsed.text.trim();
  if (parsed.html) return htmlToText(parsed.html);
  return "";
}

function addressText(
  value: AddressObject | AddressObject[] | undefined,
): string {
  if (!value) return "";
  const list = Array.isArray(value) ? value : [value];
  return list.map((a) => a.text).join(", ");
}

export function messageEpoch(parsed: ParsedMail): number {
  const ts = parsed.date?.getTime();
  if (ts !== undefined && Number.isFinite(ts)) return Math.floor(ts / 1000);
  return Math.floor(Date.now() / 1000);
}

async function extractAttachments(
  parsed: ParsedMail,
  destDir: string,
): Promise<{ names: string[]; views: string[]; tables: string[] }> {
  const names: string[] = [];
  const views: string[] = [];
  const tables: string[] = [];
  for (const att of parsed.attachments ?? []) {
    if (att.contentDisposition !== "attachment") continue;
    if (!att.content) continue;
    const name = sanitizeFilename(att.filename || "attachment");
    fs.mkdirSync(destDir, { recursive: true });
    let candidate = path.join(destDir, name);
    let n = 1;
    let alreadyStored = false;
    while (fs.existsSync(candidate)) {
      // identical bytes already extracted (e.g. a re-fetched body after
      // LRU eviction): reuse the file instead of minting "(1)" copies
      try {
        if (fs.readFileSync(candidate).equals(att.content)) {
          alreadyStored = true;
          break;
        }
      } catch {
        /* unreadable: fall through to a fresh name */
      }
      const dot = name.lastIndexOf(".");
      candidate = path.join(
        destDir,
        dot > 0
          ? `${name.slice(0, dot)}(${n})${name.slice(dot)}`
          : `${name}(${n})`,
      );
      n += 1;
    }
    if (!alreadyStored) fs.writeFileSync(candidate, att.content);
    names.push(path.basename(candidate));
    // Markdown view for readable formats (.pdf one-way, .docx packable). A
    // malformed document costs only its own view, never the message sync;
    // a real attachment already at the view path is never overwritten.
    try {
      const view = await markdownViewFor(candidate, att.content);
      if (view !== null) {
        const viewPath = candidate + ".md";
        if (!fs.existsSync(viewPath)) {
          fs.writeFileSync(viewPath, asViewFile(view));
          views.push(path.basename(viewPath));
        } else if (alreadyStored) {
          // identical re-extracted content: the sibling .md is the view
          // from the first extraction (possibly since packed — keep it)
          views.push(path.basename(viewPath));
        }
      }
    } catch (err) {
      log.warn(`no markdown view for ${candidate}: ${err}`);
    }
    // Tabular formats (spreadsheets, delimited text) get BOTH a readable .md
    // view and a structured .tabular.db sidecar the in-room `mail table` verb
    // queries. Isolated exactly like the markdown view above: a parse failure
    // (malformed workbook, absent SheetJS capability for a workbook) costs
    // only this attachment's tabular view, never the message sync. Delimited
    // text parses stdlib-side, so .csv/.tsv survive even then.
    if (isTabularAttachment(candidate)) {
      try {
        const tabular = await tabularViewFor(candidate, att.content);
        if (tabular !== null) {
          const viewPath = candidate + ".md";
          const dbPath = candidate + ".tabular.db";
          if (!fs.existsSync(viewPath)) {
            fs.writeFileSync(viewPath, asViewFile(tabular.markdown));
            views.push(path.basename(viewPath));
          } else if (alreadyStored) {
            views.push(path.basename(viewPath));
          }
          if (!fs.existsSync(dbPath) || !alreadyStored) {
            writeTabularSidecar(dbPath, tabular.parsed, {
              sourceSha: path.basename(destDir),
              sourceName: path.basename(candidate),
            });
            tables.push(path.basename(dbPath));
          } else {
            // identical re-extracted content: reuse the existing sidecar
            tables.push(path.basename(dbPath));
          }
        }
      } catch (err) {
        log.warn(`no tabular view for ${candidate}: ${err}`);
      }
    }
  }
  return { names, views, tables };
}

/**
 * Write one raw message into the account's Maildir. Returns the path, or
 * null if the message (by content sha) is already stored.
 */
export async function storeMessage(
  layout: Layout,
  index: Index,
  ledger: Ledger,
  opts: {
    account: string;
    folder: string;
    raw: Buffer;
    explained?: Set<string>;
    /** provider message id (Gmail X-GM-MSGID / Graph id) for backfill dedup */
    providerMsgId?: string;
    /** provider-neutral label set, when the provider sent one */
    labels?: string[];
  },
): Promise<string | null> {
  const { account, folder, raw, explained } = opts;
  const sha = sha12(raw);
  if (index.hasSha(sha)) return null;
  // a metadata-only row from the backfill may already stand in for this
  // message; the full-body row supersedes it
  if (opts.providerMsgId) {
    index.deleteMetaOnlyByProvider(account, opts.providerMsgId);
  }
  const parsed = await simpleParser(raw);
  const epoch = messageEpoch(parsed);
  const filename = `${epoch}.${sha}.eml`;
  const dest = path.join(
    layout.accounts,
    account,
    "mail",
    folder,
    "cur",
    filename,
  );
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, raw);

  const body = extractBodyText(parsed);
  const att = await extractAttachments(
    parsed,
    path.join(layout.attachments, sha),
  );
  const attRel = att.names.map((n) => `attachments/${sha}/${n}`);
  const viewRel = att.views.map((n) => `attachments/${sha}/${n}`);
  const tableRel = att.tables.map((n) => `attachments/${sha}/${n}`);

  const metaLines = [
    `X-Messageoperator-Sha: ${sha}`,
    `X-Messageoperator-Account: ${account}`,
  ];
  for (const p of attRel) metaLines.push(`X-Messageoperator-Attachments: ${p}`);
  for (const p of viewRel)
    metaLines.push(`X-Messageoperator-Attachment-Views: ${p}`);
  for (const p of tableRel)
    metaLines.push(`X-Messageoperator-Attachment-Tables: ${p}`);
  const metaPath = dest + ".meta";
  fs.writeFileSync(metaPath, metaLines.join("\n") + "\n\n" + body + "\n");

  const relPath = layout.rel(dest);
  // the raw Date header line, as Python's msg["Date"] gave it
  const dateLine = parsed.headerLines.find((h) => h.key === "date")?.line ?? "";
  const dateHdr =
    dateLine.replace(/^date:\s*/i, "") || (parsed.date?.toUTCString() ?? "");
  index.insertMessage({
    sha,
    account,
    folder,
    filename,
    path: relPath,
    date: dateHdr,
    epoch,
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    subject: parsed.subject || "",
    body,
    labels: opts.labels,
    gmailId: opts.providerMsgId,
    rfcMessageId: parsed.messageId || undefined,
  });
  ledger.append(
    "sync_message",
    { account, folder, path: relPath, subject: parsed.subject || "" },
    { sha },
  );
  if (explained) {
    explained.add(relPath);
    explained.add(layout.rel(metaPath));
  }
  return dest;
}

/**
 * Materialize an on-demand-fetched body for an EXISTING metadata-only row:
 * .eml + .meta into the account's .Cache Maildir, attachments extracted,
 * the row upgraded in place (path, body_cached, LRU fields) and its text
 * indexed for search. Returns the room-relative path of the cached .eml.
 */
export async function storeFetchedBody(
  layout: Layout,
  index: Index,
  ledger: Ledger,
  opts: {
    row: MessageRow;
    raw: Buffer;
    explained?: Set<string>;
  },
): Promise<string> {
  const { row, raw, explained } = opts;
  const parsed = await simpleParser(raw);
  const contentSha = sha12(raw);
  const epoch = row.epoch || messageEpoch(parsed);
  const filename = `${epoch}.${contentSha}.eml`;
  const dest = path.join(
    layout.accounts,
    row.account,
    "mail",
    ".Cache",
    "cur",
    filename,
  );
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, raw);

  const body = extractBodyText(parsed);
  const att = await extractAttachments(
    parsed,
    path.join(layout.attachments, contentSha),
  );
  const attRel = att.names.map((n) => `attachments/${contentSha}/${n}`);
  const viewRel = att.views.map((n) => `attachments/${contentSha}/${n}`);
  const tableRel = att.tables.map((n) => `attachments/${contentSha}/${n}`);

  const metaLines = [
    `X-Messageoperator-Sha: ${contentSha}`,
    `X-Messageoperator-Account: ${row.account}`,
  ];
  for (const p of attRel) metaLines.push(`X-Messageoperator-Attachments: ${p}`);
  for (const p of viewRel)
    metaLines.push(`X-Messageoperator-Attachment-Views: ${p}`);
  for (const p of tableRel)
    metaLines.push(`X-Messageoperator-Attachment-Tables: ${p}`);
  const metaPath = dest + ".meta";
  fs.writeFileSync(metaPath, metaLines.join("\n") + "\n\n" + body + "\n");

  const relPath = layout.rel(dest);
  index.attachFetchedBody(row.sha, {
    path: relPath,
    filename,
    maildirFile: `.Cache/cur/${filename}`,
    bodySize: raw.length,
    bodyText: body,
  });
  ledger.append(
    "fetch_executed",
    {
      account: row.account,
      path: relPath,
      subject: parsed.subject || row.subject,
      bytes: raw.length,
    },
    { sha: row.sha },
  );
  if (explained) {
    explained.add(relPath);
    explained.add(layout.rel(metaPath));
  }
  return relPath;
}
