// FILE: test/tabular.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  INLINE_ROW_CAP,
  parseDelimited,
  parseWorkbook,
  renderTableMarkdown,
  type ParsedTable,
} from "../src/tabular.js";
import {
  SIDECAR_SCHEMA_VERSION,
  writeTabularSidecar,
} from "../src/tabular_store.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/sample.xlsx", import.meta.url),
);

/** Open a written sidecar read-only, the same builtin the source uses. */
function openSidecar(dbPath: string) {
  const mod = process.getBuiltinModule?.("node:sqlite");
  if (!mod) throw new Error("node:sqlite unavailable");
  return new mod.DatabaseSync(dbPath, { readOnly: true });
}

describe("parseWorkbook (real xlsx fixture)", () => {
  it("enumerates sheets with dimensions and a detected header", async () => {
    const parsed = await parseWorkbook(fs.readFileSync(FIXTURE));
    expect(parsed.sheets.length).toBeGreaterThanOrEqual(1);
    expect(parsed.generator).toMatch(/^sheetjs-/);
    const sheet = parsed.sheets[0]!;
    expect(sheet.nRows).toBeGreaterThan(1);
    expect(sheet.nCols).toBeGreaterThan(1);
    // the employee fixture's first row is a string header over typed data
    expect(sheet.headerRow).toBe(0);
    expect(sheet.columns.length).toBe(sheet.nCols);
    // header text is captured on the columns
    const headers = sheet.columns.map((c) => c.header);
    expect(headers).toContain("EmployeeID");
  });

  it("preserves a formula cell's value AND formula together", async () => {
    const parsed = await parseWorkbook(fs.readFileSync(FIXTURE));
    let withFormula = 0;
    for (const sheet of parsed.sheets) {
      for (const cell of sheet.cells) {
        if (cell.formula !== null) {
          withFormula += 1;
          // the DAYS/NETWORKDAYS columns compute a value the app cached
          expect(cell.value ?? cell.valueRaw).not.toBeNull();
        }
      }
    }
    expect(withFormula).toBeGreaterThan(0);
  });

  it("records native types verbatim (numbers n, strings s)", async () => {
    const parsed = await parseWorkbook(fs.readFileSync(FIXTURE));
    const types = new Set(
      parsed.sheets.flatMap((s) => s.cells.map((c) => c.nativeType)),
    );
    expect(types.has("s")).toBe(true); // names, headers
    expect(types.has("n")).toBe(true); // ids, ages, salaries
  });

  it("omits empty cells (sparse storage)", async () => {
    const parsed = await parseWorkbook(fs.readFileSync(FIXTURE));
    const sheet = parsed.sheets[0]!;
    // every stored cell has a value or a formula; blanks were not emitted
    for (const cell of sheet.cells) {
      expect(cell.value !== null || cell.formula !== null).toBe(true);
    }
  });
});

describe("parseDelimited", () => {
  it("parses CSV with a header and typed-looking values as strings", () => {
    const csv = "name,qty\napples,3\npears,5\n";
    const parsed = parseDelimited(Buffer.from(csv), ",");
    const sheet = parsed.sheets[0]!;
    expect(parsed.generator).toBe("stdlib-dsv");
    expect(sheet.name).toBe("csv");
    expect(sheet.nRows).toBe(3);
    expect(sheet.nCols).toBe(2);
    expect(sheet.headerRow).toBe(0);
    // delimited text carries no native typing
    expect(sheet.cells.every((c) => c.nativeType === "s")).toBe(true);
  });

  it("honors RFC-4180 quoting: embedded comma, quote, newline", () => {
    const csv = 'a,b\n"has, comma","line\nbreak"\n"quote""inside",x\n';
    const parsed = parseDelimited(Buffer.from(csv), ",");
    const sheet = parsed.sheets[0]!;
    const cell = (r: number, c: number) =>
      sheet.cells.find((x) => x.rowIndex === r && x.colIndex === c)?.value;
    expect(cell(1, 0)).toBe("has, comma");
    expect(cell(1, 1)).toBe("line\nbreak");
    expect(cell(2, 0)).toBe('quote"inside');
  });

  it("parses TSV with the tab separator", () => {
    const tsv = "a\tb\n1\t2\n";
    const parsed = parseDelimited(Buffer.from(tsv), "\t");
    expect(parsed.sheets[0]!.name).toBe("tsv");
    expect(parsed.sheets[0]!.nCols).toBe(2);
  });

  it("omits empty cells", () => {
    const csv = "a,b,c\n1,,3\n";
    const parsed = parseDelimited(Buffer.from(csv), ",");
    const row1 = parsed.sheets[0]!.cells.filter((c) => c.rowIndex === 1);
    // the middle empty field is not stored
    expect(row1.map((c) => c.colIndex).sort()).toEqual([0, 2]);
  });
});

describe("renderTableMarkdown truncation honesty", () => {
  function bigSheet(dataRows: number): ParsedTable {
    const csvLines = ["col0,col1"];
    for (let i = 0; i < dataRows; i++) csvLines.push(`r${i},v${i}`);
    return parseDelimited(Buffer.from(csvLines.join("\n") + "\n"), ",");
  }

  it("renders a small table in full", () => {
    const md = renderTableMarkdown(bigSheet(3), "small.csv");
    expect(md).toContain("| r0 | v0 |");
    expect(md).toContain("| r2 | v2 |");
    expect(md).not.toContain("rows omitted");
  });

  it("truncates a large table and states the TRUE total", () => {
    const total = INLINE_ROW_CAP + 200;
    const md = renderTableMarkdown(bigSheet(total), "big.csv");
    // the omission marker carries the real count, never a silent cut
    expect(md).toMatch(new RegExp(`true total: ${total} data rows`));
    expect(md).toContain("rows omitted");
    // first and last data rows are both present
    expect(md).toContain("| r0 | v0 |");
    expect(md).toContain(`| r${total - 1} | v${total - 1} |`);
    // a middle row is gone
    expect(md).not.toContain(`| r${Math.floor(total / 2)} |`);
  });
});

/**
 * QA 2026-07-24, OBS-1 (cosmetic): `mail table` listed "4 rows × 5 cols" for a
 * CSV with 3 data rows. Everything else in the tool counts DATA rows — the
 * omission marker says "true total: N data rows", `--rows A:B` slices 0-based
 * over the rows after the header, and SKILL.md documents it that way — so the
 * dimension line is the one place the header row is silently counted in.
 *
 * The parse-level nRows (grid rows, header included) is correct and stays: it is
 * what cell addressing is relative to. This is about what the two DISPLAY
 * surfaces state — the .md view's dimension line here, and the sidecar listing
 * in mail.py (see TableVerbTests in test/test_mail_py.py, whose
 * test_list_sheets_shows_dims_and_schema still asserts the header-inclusive
 * count and has to be updated with the fix).
 */
describe("renderTableMarkdown row-count semantics (QA 2026-07-24 OBS-1)", () => {
  function csv(dataRows: number): ParsedTable {
    const lines = ["col0,col1"];
    for (let i = 0; i < dataRows; i++) lines.push(`r${i},v${i}`);
    return parseDelimited(Buffer.from(lines.join("\n") + "\n"), ",");
  }

  it("reports data rows, not grid rows, in the dimension line", () => {
    const parsed = csv(3);
    expect(parsed.sheets[0]!.nRows).toBe(4); // 3 data rows + the header row
    const md = renderTableMarkdown(parsed, "torture.csv");
    const dims = md.match(/## Sheet: .*\((\d+) rows/);
    expect(dims, "the view states its dimensions").not.toBeNull();
    expect(Number(dims![1]), "3 data rows under one header row").toBe(3);
  });

  it("agrees with its own omission marker on one truncated view", () => {
    const total = INLINE_ROW_CAP + 200;
    const md = renderTableMarkdown(csv(total), "big.csv");
    const headerCount = Number(md.match(/## Sheet: .*\((\d+) rows/)![1]);
    const markerCount = Number(md.match(/true total: (\d+) data rows/)![1]);
    // one artifact must not state two different totals for the same sheet
    expect(headerCount).toBe(markerCount);
  });
});

describe("writeTabularSidecar", () => {
  function tmpDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabular-db-"));
    return path.join(dir, "x.tabular.db");
  }

  it("writes the fixed schema and round-trips cells", async () => {
    const parsed = await parseWorkbook(fs.readFileSync(FIXTURE));
    const dbPath = tmpDb();
    writeTabularSidecar(dbPath, parsed, {
      sourceSha: "abc123",
      sourceName: "sample.xlsx",
    });
    expect(fs.existsSync(dbPath)).toBe(true);
    // no leftover temp file beside it
    const siblings = fs.readdirSync(path.dirname(dbPath));
    expect(siblings.some((n) => n.includes(".tmp"))).toBe(false);

    const db = openSidecar(dbPath);
    try {
      const version = db
        .prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get() as { value: string };
      expect(Number(version.value)).toBe(SIDECAR_SCHEMA_VERSION);
      const src = db
        .prepare("SELECT value FROM meta WHERE key='source_sha'")
        .get() as { value: string };
      expect(src.value).toBe("abc123");

      const sheetCount = db.prepare("SELECT COUNT(*) c FROM sheets").get() as {
        c: number;
      };
      expect(sheetCount.c).toBe(parsed.sheets.length);

      // a formula cell survived with both value and formula
      const fcell = db
        .prepare(
          "SELECT value, value_raw, formula FROM cells WHERE formula IS NOT NULL LIMIT 1",
        )
        .get() as
        | { value: string | null; value_raw: string | null; formula: string }
        | undefined;
      expect(fcell).toBeDefined();
      expect(fcell!.formula.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("overwrites an existing sidecar atomically", async () => {
    const parsed = parseDelimited(Buffer.from("a,b\n1,2\n"), ",");
    const dbPath = tmpDb();
    writeTabularSidecar(dbPath, parsed, {
      sourceSha: "s1",
      sourceName: "a.csv",
    });
    // second write with different content replaces cleanly
    const parsed2 = parseDelimited(Buffer.from("a,b\n9,9\n"), ",");
    writeTabularSidecar(dbPath, parsed2, {
      sourceSha: "s2",
      sourceName: "a.csv",
    });
    const db = openSidecar(dbPath);
    try {
      const src = db
        .prepare("SELECT value FROM meta WHERE key='source_sha'")
        .get() as { value: string };
      expect(src.value).toBe("s2");
    } finally {
      db.close();
    }
  });
});
