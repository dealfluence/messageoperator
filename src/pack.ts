/**
 * Markdown views of document attachments, and the DOCX "pack" pipeline that
 * rebases agent edits of a view back into the binary as native Word tracked
 * changes (@adeu/core RedlineEngine).
 *
 * PDF extraction is strictly one-way. DOCX is two-way: extraction renders
 * pending tracked changes as CriticMarkup ({++ins++} / {--del--}), and
 * packDocx() turns a modified view back into tracked changes, so pack can be
 * run repeatedly on the same document.
 */

import path from "node:path";

import {
  BatchValidationError,
  DocumentObject,
  RedlineEngine,
  extractTextFromBuffer,
  generate_edits_from_text,
} from "@adeu/core";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

import {
  parseDelimited,
  parseWorkbook,
  renderTableMarkdown,
  type ParsedTable,
} from "./tabular.js";

/** Tracked-changes author for packed edits. */
export const PACK_AUTHOR = "AI Agent";

export async function extractDocxMarkdown(buffer: Buffer): Promise<string> {
  // cleanView=false: pending tracked changes surface as CriticMarkup
  return extractTextFromBuffer(buffer, false);
}

/**
 * Stands in for a PDF that parsed cleanly and simply has no text layer — a
 * scan, or an image-only export. Without it the view is an empty file, and an
 * agent reading it cannot tell "nothing to extract" from "extraction broke" or
 * "extraction never ran". Deliberately PDF-only: the docx view is packed back
 * into the binary, so a placeholder there would land in the document as content.
 */
export const NO_PDF_TEXT_VIEW =
  "_(no extractable text: this PDF has no text layer — most likely a scan or " +
  "an image-only export. The original file is the attachment beside this " +
  "view; it needs OCR to be readable as text.)_";

export async function extractPdfMarkdown(buffer: Buffer): Promise<string> {
  // pdf.js reads the underlying ArrayBuffer from position 0, so a Buffer
  // with a nonzero byteOffset (any pooled Node buffer, and readFileSync's
  // 8-byte offset) parses shifted garbage; hand it a byteOffset-0 copy
  const copy = new Uint8Array(buffer.length);
  copy.set(buffer);
  const parsed = await pdfParse(copy as Buffer);
  return (parsed.text ?? "").trim() || NO_PDF_TEXT_VIEW;
}

/**
 * Markdown view of an attachment, or null when the format has none.
 * Malformed documents throw; callers decide how much failure to tolerate.
 */
export async function markdownViewFor(
  filename: string,
  content: Buffer,
): Promise<string | null> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".docx") return extractDocxMarkdown(content);
  if (ext === ".pdf") return extractPdfMarkdown(content);
  return null;
}

/** Tabular formats that get a sidecar + table view (workbook vs delimited). */
const WORKBOOK_EXTS = new Set([".xlsx", ".xls", ".xlsm"]);
const DELIMITED_SEPS = new Map<string, string>([
  [".csv", ","],
  [".tsv", "\t"],
]);

export function isTabularAttachment(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return WORKBOOK_EXTS.has(ext) || DELIMITED_SEPS.has(ext);
}

export interface TabularView {
  markdown: string; // eager default .md view (with honest truncation)
  parsed: ParsedTable; // full parse, for writing the .tabular.db sidecar
}

/**
 * Tabular counterpart to markdownViewFor. Unlike PDF/DOCX (a single .md
 * string), tabular attachments yield TWO artifacts — the readable .md view
 * and the structured .tabular.db sidecar — so this returns both the rendered
 * Markdown and the ParsedTable (parsed once, used for both). Returns null for
 * non-tabular files. Workbooks go through the SheetJS capability; delimited
 * text uses the stdlib reader, so .csv/.tsv still work if SheetJS is absent.
 * Throws on a parse failure; the caller isolates it to this one attachment.
 */
export async function tabularViewFor(
  filename: string,
  content: Buffer,
): Promise<TabularView | null> {
  const ext = path.extname(filename).toLowerCase();
  let parsed: ParsedTable;
  if (WORKBOOK_EXTS.has(ext)) {
    parsed = await parseWorkbook(content);
  } else {
    const sep = DELIMITED_SEPS.get(ext);
    if (sep === undefined) return null;
    parsed = parseDelimited(content, sep);
  }
  return {
    markdown: renderTableMarkdown(parsed, path.basename(filename)),
    parsed,
  };
}

/** File form of a view: exactly one trailing newline. */
export function asViewFile(markdown: string): string {
  return markdown.replace(/\n+$/, "") + "\n";
}

export type PackResult =
  | { ok: true; buffer: Buffer; view: string; editsApplied: number }
  | {
      ok: false;
      reason:
        "no_changes" | "too_divergent" | "validation_failed" | "edits_skipped";
      detail: string;
    };

/**
 * Below this document-level similarity, the edited view is treated as a
 * different document rather than an edit of this one. @adeu/core will happily
 * express "replace everything" as one giant tracked change; for an agent that
 * pasted the wrong view that is a destructive silent success, so pack refuses
 * instead. Tuned to sit well below any real revision — a full rewrite that
 * keeps the document's vocabulary still scores far higher than this.
 */
const MIN_DOCUMENT_SIMILARITY = 0.25;

/**
 * Rebase a modified Markdown view into its .docx as tracked changes.
 * All-or-nothing: any unlocatable/ambiguous edit rejects the whole batch and
 * the caller keeps the original buffer. Throws only on a malformed document.
 */
export async function packDocx(
  docxBuffer: Buffer,
  modifiedMarkdown: string,
  author: string = PACK_AUTHOR,
): Promise<PackResult> {
  const baseline = (await extractDocxMarkdown(docxBuffer)).replace(/\n+$/, "");
  const modified = modifiedMarkdown.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const rawEdits = generate_edits_from_text(baseline, modified);
  if (rawEdits.length === 0) {
    return {
      ok: false,
      reason: "no_changes",
      detail: "the Markdown view matches the document text; nothing to pack",
    };
  }
  if (similarity(baseline, modified) < MIN_DOCUMENT_SIMILARITY) {
    return {
      ok: false,
      reason: "too_divergent",
      detail:
        "the edited view barely resembles this document, so packing it would " +
        "strike out nearly every paragraph and insert new ones. If you meant " +
        "to revise this document, edit its view in place; if you meant a " +
        "different document, pack that one instead.",
    };
  }
  const edits = rawEdits;
  const doc = await DocumentObject.load(docxBuffer);
  const engine = new RedlineEngine(doc, author);
  let stats: {
    edits_applied?: number;
    edits_skipped?: number;
    skipped_details?: string[];
  };
  try {
    stats = engine.process_batch(edits) as typeof stats;
  } catch (err) {
    if (err instanceof BatchValidationError) {
      return {
        ok: false,
        reason: "validation_failed",
        detail: cleanEngineErrors(err.errors),
      };
    }
    throw err;
  }
  const skipped = stats.edits_skipped ?? 0;
  if (skipped > 0) {
    return {
      ok: false,
      reason: "edits_skipped",
      detail:
        `${skipped} of ${edits.length} edit(s) could not be applied: ` +
        (stats.skipped_details ?? []).join(" | "),
    };
  }
  makeRevisionIdsUnique(doc);
  const buffer = await doc.save();
  const view = await extractDocxMarkdown(buffer);
  return {
    ok: true,
    buffer,
    view,
    editsApplied: Math.max(
      stats.edits_applied ?? edits.length,
      changeGroups(view) - changeGroups(baseline),
    ),
  };
}

/**
 * Tracked-change annotation blocks in a view — one per change a reader sees.
 *
 * The engine's own edit count is not what the user can verify: the differ
 * merges adjacent changes, so rewriting a paragraph AND adding the next one is
 * a single engine edit that shows up as two annotated blocks. Reporting the
 * lower number reads as silent edit loss and invites an agent to re-apply work
 * that already landed (QA 2026-07-24, NEW-5), so packDocx reports whichever
 * signal is higher. Counted as a DELTA against the baseline view, because a
 * document packed twice already carries the earlier round's blocks.
 */
function changeGroups(view: string): number {
  return view.split("{>>").length - 1;
}

/**
 * Give every tracked-change element its own `w:id`.
 *
 * ECMA-376 wants revision ids unique per document; the engine reuses them
 * across the revisions of one batch (a two-insertion pack comes out as
 * w:id="2" three times), which is why the refreshed view labelled two distinct
 * insertions "[Chg:2 insert]" and made it look as though one had been lost.
 * Still present in @adeu/core 1.30.0 — the one QA 2026-07-24 pack finding
 * (NEW-5) the engine has not fixed upstream.
 *
 * Renumbering in the DOM before save avoids a zip round-trip, and is safe
 * because a w:ins/w:del id is a standalone annotation id — unlike a comment id,
 * nothing else in the package refers to it.
 */
function makeRevisionIdsUnique(doc: DocumentObject): void {
  const root = doc.element as unknown as {
    getElementsByTagName?: (name: string) => ArrayLike<{
      setAttribute?: (name: string, value: string) => void;
    }>;
  };
  if (typeof root.getElementsByTagName !== "function") return;
  let next = 1;
  for (const tag of ["w:ins", "w:del"]) {
    const nodes = root.getElementsByTagName(tag);
    for (let i = 0; i < nodes.length; i++) {
      nodes[i]?.setAttribute?.("w:id", String(next++));
    }
  }
}

/** Dice coefficient over character bigrams: cheap, and robust to rewording. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const g = new Map<string, number>();
    for (let i = 0; i + 1 < s.length; i++) {
      const k = s.slice(i, i + 2);
      g.set(k, (g.get(k) ?? 0) + 1);
    }
    return g;
  };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  let total = 0;
  for (const [k, v] of ga) {
    total += v;
    shared += Math.min(v, gb.get(k) ?? 0);
  }
  for (const v of gb.values()) total += v;
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * The engine's batch errors, made actionable for a `mail pack` caller.
 *
 * Two things have to go (QA 2026-07-24, NEW-1 and NEW-3):
 *  - the CriticMarkup and annotation bookkeeping the engine splices into its
 *    occurrence contexts ("{>>[Chg:1 delete] AI Agent … Diff: Replacement<<}").
 *    It is internal state, it names changes that exist in no file the user can
 *    open (a rejected batch leaves the document untouched), and it is noise.
 *  - the instruction to set "match_mode", which `mail pack` cannot accept.
 *    Printing it and then admitting it is unsettable, as this used to, gives one
 *    message that both prescribes and forbids the same remedy.
 */
export function cleanEngineErrors(errors: string[]): string {
  const cleaned = errors
    .map((err) =>
      err
        // annotation blocks, then any leftover CriticMarkup wrappers
        .replace(/\{>>[\s\S]*?<<\}/g, "")
        .replace(/\{--([\s\S]*?)--\}/g, "$1")
        .replace(/\{\+\+([\s\S]*?)\+\+\}/g, "$1")
        .replace(/\{==([\s\S]*?)==\}/g, "$1")
        // the match_mode strategy list, down to the last numbered option
        .replace(/\s*To resolve[^\n]*\n(?:\s*\d+\.[^\n]*\n?)*/g, "\n")
        .replace(/^\s*\d+\.\s*Set "match_mode".*$/gm, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim(),
    )
    .filter(Boolean);
  return (
    cleaned.join(" | ") +
    " — tip: give the edit more surrounding context so the target text occurs " +
    "exactly once, or insert a new distinctive sentence instead of changing a " +
    "single word in place."
  );
}
