import { describe, expect, it } from "vitest";

import {
  extractDocxMarkdown,
  extractPdfMarkdown,
  markdownViewFor,
  asViewFile,
  packDocx,
} from "../src/pack.js";
import { sampleDocx, samplePdf } from "./helpers.js";

const CONTRACT = [
  "Agreement between Alpha Corp and Beta Ltd.",
  "The fee is 100 euros, payable within 30 days.",
  "This agreement is governed by Finnish law.",
];

describe("markdown extraction", () => {
  it("extracts docx paragraphs as markdown", async () => {
    const md = await extractDocxMarkdown(sampleDocx(CONTRACT));
    expect(md).toBe(CONTRACT.join("\n\n"));
  });

  it("extracts pdf text", async () => {
    const text = await extractPdfMarkdown(samplePdf("Hello PDF world"));
    expect(text).toContain("Hello PDF world");
  });

  it("dispatches by extension, case-insensitive, null for others", async () => {
    const docx = sampleDocx(["Hi."]);
    expect(await markdownViewFor("Report.DOCX", docx)).toBe("Hi.");
    expect(await markdownViewFor("data.bin", docx)).toBeNull();
    expect(await markdownViewFor("notes.md", docx)).toBeNull();
  });

  it("throws on malformed input so callers can contain the failure", async () => {
    await expect(
      markdownViewFor("evil.docx", Buffer.from("not a zip")),
    ).rejects.toThrow();
    await expect(
      markdownViewFor("evil.pdf", Buffer.from("not a pdf")),
    ).rejects.toThrow();
  });

  it("asViewFile normalizes to exactly one trailing newline", () => {
    expect(asViewFile("text")).toBe("text\n");
    expect(asViewFile("text\n\n")).toBe("text\n");
  });
});

describe("packDocx", () => {
  it("rebases replacement, deletion, and insertion as tracked changes", async () => {
    const docx = sampleDocx(CONTRACT);
    const baseline = await extractDocxMarkdown(docx);
    const modified = baseline
      .replace("100 euros", "250 euros")
      .replace(", payable within 30 days", "")
      .replace(
        "Finnish law.",
        "Finnish law. Disputes go to arbitration in Helsinki.",
      );

    const result = await packDocx(docx, modified);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.editsApplied).toBe(3);
    // the refreshed view carries the pending changes as CriticMarkup
    expect(result.view).toContain("{--100--}");
    expect(result.view).toContain("{++250++}");
    expect(result.view).toContain("{--, payable within 30 days--}");
    expect(result.view).toContain(
      "{++ Disputes go to arbitration in Helsinki.++}",
    );
    expect(result.view).toContain("AI Agent");
    // accepting all changes yields the modified text
    const accepted = await extractDocxMarkdown(result.buffer).then(() =>
      import("@adeu/core").then((m) =>
        m.extractTextFromBuffer(result.buffer, true),
      ),
    );
    expect(accepted).toContain("250 euros");
    expect(accepted).toContain("arbitration in Helsinki");
    expect(accepted).not.toContain("payable within 30 days");
  });

  it("supports iterating: packing an already-redlined docx again", async () => {
    const docx = sampleDocx(CONTRACT);
    const baseline = await extractDocxMarkdown(docx);
    const first = await packDocx(docx, baseline.replace("100", "250"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await packDocx(
      first.buffer,
      first.view.replace("Alpha Corp", "Alpha Oy"),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.view).toContain("{--Corp--}");
    expect(second.view).toContain("{++Oy++}");
    expect(second.view).toContain("{--100--}"); // first round still pending
  });

  it("anchors a brand-new paragraph appended at the end", async () => {
    const docx = sampleDocx(CONTRACT);
    const baseline = await extractDocxMarkdown(docx);
    const result = await packDocx(
      docx,
      baseline + "\n\nNew clause: confidentiality survives termination.",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view).toContain(
      "{++New clause: confidentiality survives termination.++}",
    );
  });

  it("anchors a paragraph inserted between existing paragraphs", async () => {
    const docx = sampleDocx(CONTRACT);
    const baseline = await extractDocxMarkdown(docx);
    const result = await packDocx(
      docx,
      baseline.replace(
        "\n\nThis agreement",
        "\n\nSevered clause here.\n\nThis agreement",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view).toContain("{++Severed clause here.++}");
    // the paragraph it was anchored next to is intact
    expect(result.view).toContain("This agreement is governed by Finnish law.");
  });

  it("treats an unchanged view as no_changes", async () => {
    const docx = sampleDocx(CONTRACT);
    const baseline = await extractDocxMarkdown(docx);
    const result = await packDocx(docx, baseline);
    expect(result).toMatchObject({ ok: false, reason: "no_changes" });
  });

  it("tolerates CRLF and trailing-newline differences from editors", async () => {
    const docx = sampleDocx(CONTRACT);
    const baseline = await extractDocxMarkdown(docx);
    const noise = baseline.replace(/\n/g, "\r\n") + "\r\n";
    const result = await packDocx(docx, noise);
    expect(result).toMatchObject({ ok: false, reason: "no_changes" });
  });

  /**
   * A repeated value is no longer ambiguous: pack widens each target with
   * surrounding baseline text until it occurs exactly once, so the edit lands
   * where the user made it. Previously this whole batch was rejected with
   * "Ambiguous match" (QA 2026-07-24, NEW-2). What must never happen is the
   * OTHER occurrence moving — that is the property under test now.
   */
  it("disambiguates a repeated value by context instead of guessing", async () => {
    const docx = sampleDocx(["fee: 100", "cap: 100"]);
    const baseline = await extractDocxMarkdown(docx);
    const result = await packDocx(
      docx,
      baseline.replace("fee: 100", "fee: 200"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { extractTextFromBuffer } = await import("@adeu/core");
    expect(await extractTextFromBuffer(result.buffer, true)).toBe(
      "fee: 200\n\ncap: 100",
    );
  });

  /**
   * Byte-identical paragraphs: the engine resolves by the position the differ
   * recorded, so the FIRST is edited and the second is left alone. What matters
   * is that it never edits both — one edit must not become two.
   */
  it("edits only the occurrence the user changed, even between identical paragraphs", async () => {
    const docx = sampleDocx(["fee: 100 on receipt.", "fee: 100 on receipt."]);
    const baseline = await extractDocxMarkdown(docx);
    const result = await packDocx(
      docx,
      baseline.replace("fee: 100 on receipt.", "fee: 200 on receipt."),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { extractTextFromBuffer } = await import("@adeu/core");
    expect(await extractTextFromBuffer(result.buffer, true)).toBe(
      "fee: 200 on receipt.\n\nfee: 100 on receipt.",
    );
  });

  /**
   * The accept side of MIN_DOCUMENT_SIMILARITY. A heavy revision — every
   * paragraph reworded — must still pack; only a view that is a DIFFERENT
   * document is refused. Measured margin is wide (a full same-subject rewrite
   * scores ~0.61 against a 0.25 threshold, an unrelated document ~0.21), and
   * this pins it so the threshold cannot creep up into legitimate edits.
   */
  it("packs a revision that rewords every paragraph", async () => {
    const docx = sampleDocx(CONTRACT);
    const result = await packDocx(
      docx,
      [
        "Contract between Alpha Oy and Beta Limited.",
        "The charge is 250 euros, due on receipt.",
        "This contract is governed by the laws of Finland.",
      ].join("\n\n"),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects edits whose target no longer exists", async () => {
    const docx = sampleDocx(CONTRACT);
    // hand the packer a "modified" text diverging from an unrelated baseline:
    // the diff produces targets the document does not contain
    const result = await packDocx(
      docx,
      "Entirely unrelated document.\n\nWith other content.",
    );
    expect(result.ok).toBe(false);
  });

  it("throws on a malformed docx buffer", async () => {
    await expect(packDocx(Buffer.from("junk"), "text")).rejects.toThrow();
  });
});
