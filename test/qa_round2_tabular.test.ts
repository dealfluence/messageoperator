// FILE: test/qa_round2_tabular.test.ts
/**
 * QA round 2 (2026-07-24), NEW-7: `mail table` reported an 8-record CSV as
 * "15 rows × 5 cols", with a blank row interleaved after every real row.
 *
 * The reported root cause — "Source file is 9 physical lines with CRLF
 * terminators; \r and \n are each being treated as a row separator" — is
 * WRONG, and the first test below is the guard that says so: parseDelimited
 * handles CRLF correctly.
 *
 * What the fixture on disk actually contains is CR CR LF:
 *
 *   $ od -c 'attachments/qa-fixtures/torture,data ÄÖ.csv'
 *   ,   n   o   t   e  \r  \r  \n   0   0   0   1   ,   "   K   a
 *
 * 8 of its 9 terminators are \r\r\n; the one inside the quoted field is a
 * plain \r\n. That is the signature of content authored with CRLF endings and
 * then written through a Windows TEXT-mode handle, which rewrites every \n as
 * \r\n and so doubles the CR. The room preserved those bytes faithfully
 * end-to-end (sha256 verified identical on both send paths), so the malformed
 * input predates Message Operator — it came in with the fixture.
 *
 * And on those bytes Message Operator is not even wrong: Python's csv module, run on
 * the identical file, yields the same 16 grid rows (8 real + 8 blank) = 15
 * data rows. So NEW-7 is NOT a parser defect.
 *
 * It is still worth fixing, which is what the second test asks for. The .csv.md
 * view exists to keep an agent from misreading data — src/tabular.ts already
 * carries a comment about a dimension line that made an agent slice a row
 * short — and a view that doubles the row count and blanks every other row
 * defeats that purpose regardless of what a strict RFC 4180 reader would do.
 * Tolerating \r\r\n as one terminator is what real-world CSV readers do.
 */

import { describe, expect, it } from "vitest";

import {
  dataRowCount,
  parseDelimited,
  renderTableMarkdown,
} from "../src/tabular.js";

/** The live-room fixture, rebuilt byte-exactly. */
const HEADER = "id,vendor,amount_eur,iban_prefix,note";
const RECORDS = [
  '0001,"Kanerva Oy, Jyväskylä",1234.50,FI21,"multiline\r\nsecond line, with comma"',
  "0003,+SUM(A1:A9),0.01,FI44,leading plus",
  '0004,-2+3,-45.00,FI55,"leading minus, negative"',
  '0006,"Ääkkös Ømsætning ☃",88888.88,FI77,"unicode payload åäö ÅÄÖ שלום 🧪"',
  '0007,"quote""inside",12.00,FI88,embedded doublequote',
  "0008,From here mbox trap,3.14,FI99,line starts with From",
  "0009,0000123,0.00,FI10,leading zeros preserved",
];

/** Row terminator between records; the embedded \r\n inside a field stays. */
function fixture(terminator: string): Buffer {
  return Buffer.from(
    [HEADER, ...RECORDS].join(terminator) + terminator,
    "utf-8",
  );
}

const DATA_ROWS = RECORDS.length; // 7 records + header = 8 grid rows

describe("parseDelimited line endings (QA 2026-07-24 NEW-7)", () => {
  /**
   * GREEN: refutes NEW-7's stated root cause. Well-formed CRLF is handled
   * correctly — no phantom rows — so the reported "\r and \n are each treated
   * as a row separator" does not happen.
   */
  it("treats a well-formed CRLF terminator as ONE row separator", () => {
    const sheet = parseDelimited(fixture("\r\n"), ",").sheets[0]!;
    expect(sheet.nRows).toBe(DATA_ROWS + 1); // + header
    expect(dataRowCount(sheet)).toBe(DATA_ROWS);
    // no blank row anywhere in the grid
    const rowsWithCells = new Set(sheet.cells.map((c) => c.rowIndex));
    expect(rowsWithCells.size).toBe(DATA_ROWS + 1);
  });

  it("handles bare LF the same way", () => {
    const sheet = parseDelimited(fixture("\n"), ",").sheets[0]!;
    expect(dataRowCount(sheet)).toBe(DATA_ROWS);
  });

  /**
   * RED: the actual NEW-7 symptom, and the hardening ask. CR CR LF must count
   * as one row terminator, not two, so the view an agent reads reports the
   * true record count.
   */
  it("treats CR CR LF as ONE row separator, not two", () => {
    const sheet = parseDelimited(fixture("\r\r\n"), ",").sheets[0]!;
    expect(
      dataRowCount(sheet),
      `a ${DATA_ROWS}-record CSV written with CRCRLF terminators is reported ` +
        `as ${dataRowCount(sheet)} rows`,
    ).toBe(DATA_ROWS);
  });

  it("does not interleave blank rows into the rendered view", () => {
    const parsed = parseDelimited(fixture("\r\r\n"), ",");
    const md = renderTableMarkdown(parsed, "torture,data ÄÖ.csv");
    // table rows whose every cell is empty; the `| --- |` separator has
    // non-empty cells and is correctly not counted
    const blankRows = md.split("\n").filter((line) => {
      if (!line.startsWith("|")) return false;
      const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|");
      return cells.length > 1 && cells.every((c) => c.trim() === "");
    });
    expect(
      blankRows.length,
      `rendered view carries ${blankRows.length} all-empty data rows:\n${md}`,
    ).toBe(0);
  });

  /**
   * Values must survive whichever way the terminator question is settled —
   * these are the parts of the torture fixture that already work, pinned so a
   * terminator fix cannot regress them.
   */
  it("preserves leading zeros, embedded separators, quotes and unicode", () => {
    const parsed = parseDelimited(fixture("\r\n"), ",");
    const sheet = parsed.sheets[0]!;
    const at = (row: number, col: number) =>
      sheet.cells.find((c) => c.rowIndex === row && c.colIndex === col)?.value;

    expect(at(1, 0)).toBe("0001"); // leading zero not coerced to 1
    expect(at(1, 1)).toBe("Kanerva Oy, Jyväskylä"); // comma inside quotes
    expect(at(1, 4)).toBe("multiline\r\nsecond line, with comma"); // embedded newline
    expect(at(5, 1)).toBe('quote"inside'); // doubled "" unescaped
    expect(at(7, 1)).toBe("0000123");
    expect(at(4, 1)).toBe("Ääkkös Ømsætning ☃");
    expect(at(4, 4)).toBe("unicode payload åäö ÅÄÖ שלום 🧪");
    // every column typed as text, which is what protects the leading zeros
    expect(sheet.columns.every((c) => c.nativeType === "s")).toBe(true);
  });
});
