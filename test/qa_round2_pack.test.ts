// FILE: test/qa_round2_pack.test.ts
/**
 * Reproductions for the `mail pack` defects found in QA round 2 (2026-07-24):
 * NEW-1, NEW-2, NEW-3, NEW-4, NEW-5.
 *
 * Every case here reproduces with `sampleDocx()` — no 37 KB binary fixture is
 * needed. The live-room fixture that surfaced these
 * (attachments/c2231d999678/"QA2 sopimus ÄÖ ☃.docx") is only a longer version
 * of the same shapes.
 *
 * All five defects originate below packDocx(), in @adeu/core's RedlineEngine
 * and word-level differ. They are fixed in the planEdits() adapter in
 * src/pack.ts, which shapes the batch so the engine cannot reach its own bad
 * paths: paragraph-aligned diffing, targets widened to be unique, insertions
 * split out and ordered first, and revision ids renumbered before save.
 *
 * Assertions deliberately avoid the annotation timestamps that appear in
 * engine output — those change every run.
 */

import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  PACK_AUTHOR,
  cleanEngineErrors,
  extractDocxMarkdown,
  packDocx,
} from "../src/pack.js";
import { sampleDocx } from "./helpers.js";

/** word/document.xml out of a packed .docx. */
function documentXml(buffer: Buffer): string {
  const entry = unzipSync(new Uint8Array(buffer))["word/document.xml"];
  if (!entry) throw new Error("packed docx has no word/document.xml");
  return strFromU8(entry);
}

/** Every `w:id` carried by a `<w:ins>`/`<w:del>` revision element, in order. */
function revisionIds(xml: string): string[] {
  return [...xml.matchAll(/<w:(?:ins|del)\s[^>]*w:id="(\d+)"/g)].map(
    (m) => m[1]!,
  );
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Text of the document with all tracked changes accepted. */
async function acceptedText(buffer: Buffer): Promise<string> {
  const core = await import("@adeu/core");
  return core.extractTextFromBuffer(buffer, true);
}

/** Paragraph list, blank-line separated, for comparing intent vs. result. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * QA 2026-07-24, NEW-1 (medium-high).
 *
 * `mail pack` submits the whole batch to RedlineEngine.process_batch(). The
 * engine applies edits one at a time and matches each subsequent edit against
 * the document AS ALREADY MUTATED by its predecessors — including the
 * CriticMarkup annotation blocks it just synthesised ("{>>[Chg:1 delete] AI
 * Agent … Diff: Replacement<<}"). That serialized bookkeeping is not document
 * content, but the matcher treats it as content, so:
 *
 *   - occurrence counts exceed what the document actually contains,
 *   - failures cite state that exists in no file the user can open (the batch
 *     is atomic, so a rejected batch leaves the original bytes untouched — the
 *     QA run verified the input .docx was byte-identical to pristine, sha256
 *     5ce25034b8776e828423, after the engine reported a tracked deletion),
 *   - internal markup leaks into user-facing error text.
 *
 * Reproduced live in round 2 as: "Edit 4 Failed: Target text matches text
 * inside a tracked deletion by AI Agent."
 */
describe("mail pack: batch validation matches against phantom state (NEW-1)", () => {
  /**
   * The document contains the word "Agent" exactly ONCE. Edit 1 (an unrelated
   * fee change) makes the engine stamp "[Chg:n delete] AI Agent / [Chg:n
   * insert] AI Agent / [Com:n] AI Agent @ <ts>" into its working copy. Edit 2
   * then targets "Agent" and is told it matches FOUR times.
   *
   * Deterministic: keyed on the author name the annotations always carry
   * (PACK_AUTHOR), not on the timestamp digits that made the original QA
   * repro (target "3" colliding with a "…T19:53:46Z…" annotation) unstable.
   */
  it("does not count its own annotation metadata as matchable document text", async () => {
    const docx = sampleDocx([
      "Clause 1. The fee is 100 euros, payable on receipt.",
      `Clause 2. The ${PACK_AUTHOR.split(" ")[1]} shall keep records of every payment.`,
    ]);
    const baseline = await extractDocxMarkdown(docx);
    expect(countOf(baseline, "Agent")).toBe(1); // exactly one, in the document

    const result = await packDocx(
      docx,
      baseline
        .replace("100 euros", "250 euros") // edit 1 → creates annotations
        .replace("The Agent shall", "The Contractor shall"), // edit 2 → targets "Agent"
    );

    if (!result.ok) {
      const reported = /appears (\d+) times/.exec(result.detail)?.[1];
      expect(
        reported,
        `"Agent" occurs once in the document but the matcher reported ` +
          `${reported} occurrences; the extras are annotation metadata from ` +
          `edit 1 of the same batch:\n${result.detail}`,
      ).toBe("1");
    }
    expect(result.ok, `pack rejected a batch of two locatable edits`).toBe(
      true,
    );
  });

  it("keeps annotation serialization out of user-facing error text", async () => {
    const docx = sampleDocx([
      "Clause 1. The fee is 100 euros, payable on receipt.",
      "Clause 2. The Agent shall keep records of every payment.",
    ]);
    const baseline = await extractDocxMarkdown(docx);
    const result = await packDocx(
      docx,
      baseline
        .replace("100 euros", "250 euros")
        .replace("The Agent shall", "The Contractor shall"),
    );
    if (result.ok) return; // nothing to leak

    // These are engine bookkeeping tokens. A user reading `mail pack` output
    // cannot act on them, and they name changes no file on disk contains.
    for (const leak of ["{>>", "<<}", "[Chg:", "[Com:", "Diff: Replacement"]) {
      expect(
        result.detail.includes(leak),
        `error text leaks internal markup ${JSON.stringify(leak)}:\n${result.detail}`,
      ).toBe(false);
    }
  });

  /**
   * Atomicity is a deliberate design choice (see packDocx's contract), but
   * combined with phantom-state matching it means one edit that is only
   * ambiguous *against invented text* discards a batch of otherwise-valid
   * edits. This is the QA's third listed effect.
   */
  it("does not let a phantom-state failure discard unrelated valid edits", async () => {
    const docx = sampleDocx([
      "Clause 1. Term. This Agreement runs for a period of three (3) years from the Effective Date.",
      "Clause 2. Governing law. Finnish law applies and Helsinki courts have exclusive jurisdiction.",
      "Clause 3. Liability cap. Aggregate liability shall not exceed EUR 10,000.",
    ]);
    const baseline = await extractDocxMarkdown(docx);
    const modified = baseline
      .replace("three (3) years", "one (1) year")
      .replace("EUR 10,000", "EUR 50,000")
      .replace("Helsinki courts", "Espoo courts");

    const result = await packDocx(docx, modified);
    expect(
      result.ok,
      `all three edits target text present exactly once, but the batch was ` +
        `rejected:\n${result.ok ? "" : result.detail}`,
    ).toBe(true);
  });
});

/**
 * QA 2026-07-24, NEW-2 (medium).
 *
 * The user edits a Markdown view in sentences. generate_edits_from_text()
 * decomposes that into word-level edits, so replacing a whole sentence can
 * emit an edit whose target_text is a single token ("3"), which then matches
 * every other "3" in the document and is rejected as ambiguous. The user is
 * blamed for an ambiguity they never introduced: their edit — the sentence —
 * was unique.
 *
 * The QA notes this looks like the same failure class as the Adeu
 * comment-anchor bug (anchors binding to the first fragment of a word-level
 * diff); both sit on @adeu/core's differ, so it is worth checking whether one
 * fix covers both.
 */
describe("mail pack: word-level decomposition manufactures ambiguity (NEW-2)", () => {
  it("matches at the granularity the user actually edited", async () => {
    const docx = sampleDocx([
      "Clause 1. Term. This Agreement shall remain in effect for a period of three (3) years from the Effective Date.",
      "Clause 2. Governing law. This Agreement shall be governed by the laws of Finland.",
      "Clause 3. Liability cap. Each party's aggregate liability shall not exceed EUR 10,000.",
    ]);
    const baseline = await extractDocxMarkdown(docx);
    const sentence =
      "Clause 1. Term. This Agreement shall remain in effect for a period of three (3) years from the Effective Date.";
    const rewritten =
      "Clause 1. Term. This Agreement shall remain in effect for a period of one (1) year from the Effective Date.";
    expect(countOf(baseline, sentence)).toBe(1); // the user's edit IS unique

    const result = await packDocx(docx, baseline.replace(sentence, rewritten));
    expect(
      result.ok,
      `a uniquely-identified sentence rewrite was rejected because the ` +
        `differ reduced it to a token that occurs elsewhere:\n` +
        `${result.ok ? "" : result.detail}`,
    ).toBe(true);
  });
});

/**
 * QA 2026-07-24, NEW-3 (low).
 *
 * The engine's own error text tells the caller to set "match_mode": "all" or
 * "first". `mail pack` has no such flag, and src/pack.ts appends a tip saying
 * so — so a single error message both prescribes and forbids the same remedy.
 * Whichever way it is resolved (expose --match-mode, or strip the engine's
 * JSON-only advice), one message must not carry both.
 */
describe("mail pack: remediation advice contradicts itself (NEW-3)", () => {
  /**
   * @adeu/core 1.30.0 resolves these shapes by position instead of rejecting
   * them, so there is no longer a packDocx() call that reliably produces an
   * ambiguity error to inspect. The contract is therefore pinned directly on
   * the sanitiser, using an error string captured verbatim from the 1.18.5 run
   * that produced the finding — if a future engine starts emitting this shape
   * again, the wrapper still has to clean it.
   */
  it("strips engine bookkeeping and match_mode advice from raw error text", () => {
    const raw = [
      "- Edit 2 Failed: Ambiguous match. Target text appears 2 times. First 2 occurrences:\n" +
        '    1. "...{--100--}{++250++}{>>[Chg:1 delete] AI Agent\n' +
        '[Com:1] AI Agent @ 2026-07-24T19:53:46Z: Diff: Replacement<<} ([3]) years..."\n' +
        '    2. "...Clause [3]. Liability cap..."\n' +
        "  To resolve, re-send this edit using ONE of these strategies:\n" +
        '    1. Set "match_mode": "all" to modify ALL 2 occurrences (same target_text).\n' +
        '    2. Set "match_mode": "first" to modify only the FIRST occurrence.\n',
    ];
    const cleaned = cleanEngineErrors(raw);
    for (const leak of [
      "{>>",
      "<<}",
      "[Chg:",
      "[Com:",
      "{--",
      "{++",
      "match_mode",
    ]) {
      expect(cleaned, `leaks ${leak}`).not.toContain(leak);
    }
    // the useful part survives
    expect(cleaned).toContain("Ambiguous match");
    expect(cleaned).toContain("Clause [3]. Liability cap");
  });
});

/**
 * QA 2026-07-24, NEW-4 (low-medium) — the most damaging of the five, because
 * it is SILENT.
 *
 * When a replacement at the end of a paragraph is followed by an insertion of
 * a new paragraph, the differ matches the trailing punctuation (and here the
 * trailing word) as common suffix context ACROSS the paragraph break. The
 * final "." of the inserted clause is attributed to the preceding clause, so
 * accepting the tracked changes yields a document that differs from what the
 * user wrote: one clause gains a doubled period, the next loses its own.
 *
 * Live round-2 output, exactly reproduced by the first case below:
 *   Clause 5. …attributed to the AI Agent author..   <- doubled
 *   Clause 6. …Jyväskylä ÅÄÖ and a snowman ☃         <- period gone
 */
/**
 * A batch that packs SUCCESSFULLY (so the resulting binary can be inspected):
 * one replacement at the end of the only paragraph, plus one appended
 * paragraph. Shared by the NEW-4 and NEW-5 cases below. The trailing " test."
 * is common to both versions, which is exactly what the differ mis-attributes.
 */
const PUNCT_ORIGINAL =
  "Clause 5. This sentence is the designated edit target for the test.";
const punctIntended = (baseline: string) =>
  baseline.replace(
    PUNCT_ORIGINAL,
    "Clause 5. This sentence was rewritten by the agent.",
  ) + "\n\nClause 6. Newly inserted clause for the pure-insertion test.";

describe("mail pack: terminal punctuation crosses edit boundaries (NEW-4)", () => {
  it("accepting the changes reproduces the text the user wrote", async () => {
    const original =
      "Clause 5. This sentence is the designated edit target for the mail pack tracked-changes test.";
    const docx = sampleDocx([original]);
    const baseline = await extractDocxMarkdown(docx);
    const intended =
      baseline.replace(
        original,
        "Clause 5. This sentence was rewritten by the agent to verify that mail pack emits Word tracked changes attributed to the AI Agent author.",
      ) +
      "\n\nClause 6. Newly inserted clause for the pure-insertion test, including unicode Jyväskylä ÅÄÖ and a snowman ☃.";

    const result = await packDocx(docx, intended);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const accepted = await acceptedText(result.buffer);
    expect(paragraphs(accepted)).toEqual(paragraphs(intended));
  });

  it("does not migrate a whole trailing word to the previous paragraph", async () => {
    const docx = sampleDocx([PUNCT_ORIGINAL]);
    const baseline = await extractDocxMarkdown(docx);
    const intended = punctIntended(baseline);

    const result = await packDocx(docx, intended);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const accepted = await acceptedText(result.buffer);
    // the shared suffix " test." must not be re-parented onto clause 5
    expect(accepted).not.toMatch(/by the agent\.\s+test\./);
    expect(paragraphs(accepted)).toEqual(paragraphs(intended));
  });
});

/**
 * QA 2026-07-24, NEW-5 (low).
 *
 * Two independent bookkeeping errors in one pack:
 *  - every <w:ins>/<w:del> must carry a UNIQUE w:id (ECMA-376 revision
 *    identity); a packed file reuses ids, which is why the view showed
 *    "[Chg:2 insert]" twice for two distinct insertions.
 *  - editsApplied under-reports. Under-reporting applied edits reads to an
 *    agent like silent edit loss, and an agent that "repairs" the difference
 *    will double-apply.
 */
describe("mail pack: revision bookkeeping (NEW-5)", () => {
  it("gives every revision a unique w:id", async () => {
    const docx = sampleDocx([PUNCT_ORIGINAL]);
    const baseline = await extractDocxMarkdown(docx);
    const result = await packDocx(docx, punctIntended(baseline));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = revisionIds(documentXml(result.buffer));
    expect(ids.length).toBeGreaterThan(1);
    expect(
      ids,
      `w:id values must be unique per revision, got ${JSON.stringify(ids)}`,
    ).toEqual([...new Set(ids)]);
  });

  it("never under-reports against what the engine applied", async () => {
    const docx = sampleDocx([PUNCT_ORIGINAL]);
    const baseline = await extractDocxMarkdown(docx);
    const modified = punctIntended(baseline);

    const { generate_edits_from_text } = await import("@adeu/core");
    const submitted = generate_edits_from_text(
      baseline.replace(/\n+$/, ""),
      modified.replace(/\n+$/, ""),
    );
    expect(submitted.length).toBeGreaterThan(0);

    const result = await packDocx(docx, modified);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.editsApplied).toBeGreaterThanOrEqual(submitted.length);
  });

  /**
   * The trust property behind the QA's "edit miscount": pack must never report
   * FEWER edits than the user can see change groups for, because a low number
   * reads as silent edit loss and invites an agent to re-apply work that
   * already landed.
   */
  it("never under-reports against the change groups in the view", async () => {
    const docx = sampleDocx([PUNCT_ORIGINAL]);
    const baseline = await extractDocxMarkdown(docx);
    const result = await packDocx(docx, punctIntended(baseline));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const groupsInView = countOf(result.view, "{>>");
    expect(groupsInView).toBeGreaterThan(0);
    expect(
      result.editsApplied,
      `view shows ${groupsInView} change groups but pack reported only ` +
        `${result.editsApplied} edit(s) applied:\n${result.view}`,
    ).toBeGreaterThanOrEqual(groupsInView);
  });
});
