// FILE: src/tabular.ts
/**
 * Tabular attachment parsing + default-view rendering.
 *
 * The capability behind spreadsheet/delimited attachment views. Mirrors the
 * role pack.ts plays for PDF/DOCX: turn a binary attachment into a readable
 * text representation at sync time, on the broker side of the wall, so the
 * data is inline-readable the instant mail syncs — no cross-machine copy.
 *
 * This module is PURE with respect to the filesystem: parsing takes a Buffer
 * and returns a plain ParsedTable; writing the SQLite sidecar lives in
 * tabular_store.ts. Two parse paths:
 *   - parseWorkbook  (.xlsx/.xls/.xlsm) via SheetJS, loaded lazily so a .csv
 *     never pays for it and a missing/broken SheetJS fails ONLY the workbook
 *     path (graceful degradation, per the per-attachment failure model).
 *   - parseDelimited (.csv/.tsv/...) via a small stdlib RFC-4180 reader, so
 *     delimited text still works even if the heavier capability is absent.
 *
 * Cell model (confirmed empirically against SheetJS 0.20.3 on real files):
 *   value       <- cell.w  (formatted display text; what the user "means")
 *   value_raw   <- cell.v  (raw underlying value; for computing over)
 *   native_type <- cell.t  ('s'|'n'|'b'|'d'|'e'|'z', verbatim)
 *   formula     <- cell.f  (formula source without '='), or null
 * Dates a spreadsheet stored as text come back as native_type 's' and are
 * preserved verbatim; NON-destructive display-type inference is mail.py's job.
 */

/** Inline-render cap: rows shown before truncation kicks in (first + last). */
export const INLINE_ROW_CAP = 50;
const HEAD_ROWS = 25;
const TAIL_ROWS = 25;

export interface TableColumn {
  colIndex: number;
  header: string | null; // best-guess header text, or null
  nativeType: string; // dominant SheetJS type across the column
}

export interface TableCell {
  rowIndex: number;
  colIndex: number;
  value: string | null; // formatted display text (SheetJS .w)
  valueRaw: string | null; // raw underlying value (SheetJS .v, stringified)
  nativeType: string; // SheetJS .t verbatim
  formula: string | null; // SheetJS .f, or null
}

export interface TableSheet {
  sheetIndex: number;
  name: string;
  // GRID rows, header row included: cell rowIndexes are relative to this.
  // Everything user-facing counts DATA rows instead (nRows minus the header
  // row) — `--rows A:B`, the record/jsonl formats, the omission marker and the
  // dimension line all agree on that. See dataRowCount().
  nRows: number;
  nCols: number;
  headerRow: number | null; // best-guess header row index, or null
  columns: TableColumn[];
  cells: TableCell[]; // sparse: empty cells omitted
}

export interface ParsedTable {
  sheets: TableSheet[];
  generator: string; // e.g. "sheetjs-0.20.3" or "stdlib-dsv"
}

/** Stringify a raw SheetJS value (v) without losing fidelity for our columns. */
function rawToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

/**
 * Best-guess header row: row 0 is treated as a header iff every non-empty
 * cell in it is a string AND at least one lower row carries a non-string
 * (numeric/date/bool) cell. Conservative: returns null when unsure. NEVER
 * used to drop or hide a row — only to hint display/schema.
 */
function guessHeaderRow(cells: TableCell[]): number | null {
  const row0 = cells.filter((c) => c.rowIndex === 0);
  if (row0.length === 0) return null;
  const allStrings = row0.every((c) => c.nativeType === "s");
  if (!allStrings) return null;
  const belowHasNonString = cells.some(
    (c) => c.rowIndex > 0 && c.nativeType !== "s" && c.nativeType !== "z",
  );
  return belowHasNonString ? 0 : null;
}

/** Dominant native type in a column (most frequent non-empty), for schema. */
function dominantType(cells: TableCell[], colIndex: number): string {
  const counts = new Map<string, number>();
  for (const c of cells) {
    if (c.colIndex !== colIndex) continue;
    if (c.nativeType === "z") continue; // stub/blank
    counts.set(c.nativeType, (counts.get(c.nativeType) ?? 0) + 1);
  }
  let best = "s";
  let bestN = -1;
  for (const [t, n] of counts) {
    if (n > bestN) {
      best = t;
      bestN = n;
    }
  }
  return best;
}

/** Build TableColumn[] from cells + a header-row guess. */
function buildColumns(
  cells: TableCell[],
  nCols: number,
  headerRow: number | null,
): TableColumn[] {
  const columns: TableColumn[] = [];
  for (let c = 0; c < nCols; c++) {
    let header: string | null = null;
    if (headerRow !== null) {
      const hc = cells.find(
        (x) => x.rowIndex === headerRow && x.colIndex === c,
      );
      header = hc?.value ?? null;
    }
    columns.push({ colIndex: c, header, nativeType: dominantType(cells, c) });
  }
  return columns;
}

/**
 * Parse a spreadsheet workbook. SheetJS is imported lazily so this path — and
 * only this path — depends on it; a load/parse failure throws and the caller
 * isolates it to this one attachment.
 */
export async function parseWorkbook(buffer: Buffer): Promise<ParsedTable> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buffer, {
    type: "buffer",
    cellFormula: true,
    cellDates: true,
    cellNF: false,
    dense: false,
  });
  const sheets: TableSheet[] = [];
  wb.SheetNames.forEach((name, sheetIndex) => {
    const ws = wb.Sheets[name];
    const ref = ws && ws["!ref"];
    if (!ref) {
      sheets.push({
        sheetIndex,
        name,
        nRows: 0,
        nCols: 0,
        headerRow: null,
        columns: [],
        cells: [],
      });
      return;
    }
    const range = XLSX.utils.decode_range(ref);
    const cells: TableCell[] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (!cell) continue; // empty cell: omit (gap encodes emptiness)
        const value = cell.w != null ? String(cell.w) : rawToString(cell.v);
        cells.push({
          rowIndex: r - range.s.r,
          colIndex: c - range.s.c,
          value,
          valueRaw: rawToString(cell.v),
          nativeType: String(cell.t ?? "z"),
          formula: cell.f != null ? String(cell.f) : null,
        });
      }
    }
    const nRows = range.e.r - range.s.r + 1;
    const nCols = range.e.c - range.s.c + 1;
    const headerRow = guessHeaderRow(cells);
    sheets.push({
      sheetIndex,
      name,
      nRows,
      nCols,
      headerRow,
      columns: buildColumns(cells, nCols, headerRow),
      cells,
    });
  });
  return { sheets, generator: `sheetjs-${XLSX.version}` };
}

/**
 * Parse delimited text (CSV/TSV) with a small RFC-4180 reader: quoted fields,
 * doubled "" escapes, embedded newlines and separators inside quotes, CRLF or
 * LF line endings. Stdlib-only (no SheetJS), so delimited attachments work
 * even when the workbook capability is unavailable. Values are stored as text
 * verbatim; no type coercion here (inference is mail.py's job).
 */
export function parseDelimited(buffer: Buffer, sep: string): ParsedTable {
  const text = buffer.toString("utf-8");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === sep) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // A RUN of CRs terminated by \n is ONE row separator. That is what a
      // CRLF file looks like after a Windows text-mode write doubled every CR
      // ("\r\r\n"), and real mail attachments arrive that way; splitting on
      // each CR emits a phantom blank row per record and doubles the row count
      // an agent reports to the user (QA 2026-07-24, NEW-7).
      //
      // A CR run NOT ending in \n is left alone — one separator per CR — so a
      // classic Mac CR-delimited file keeps its genuine blank rows.
      let j = i;
      while (text[j] === "\r") j += 1;
      i = text[j] === "\n" ? j + 1 : i + 1;
      pushRow();
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // flush trailing field/row unless the file ended exactly on a newline
  if (field.length > 0 || row.length > 0) pushRow();

  const nCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const cells: TableCell[] = [];
  rows.forEach((r, rowIndex) => {
    r.forEach((val, colIndex) => {
      if (val === "") return; // omit empty, consistent with the workbook path
      cells.push({
        rowIndex,
        colIndex,
        value: val,
        valueRaw: val,
        nativeType: "s", // delimited text carries no native typing
        formula: null,
      });
    });
  });
  const headerRow = cells.length ? 0 : null; // delimited: assume row 0 header, but never drop it
  const sheet: TableSheet = {
    sheetIndex: 0,
    name: sep === "\t" ? "tsv" : "csv",
    nRows: rows.length,
    nCols,
    headerRow,
    columns: buildColumns(cells, nCols, headerRow),
    cells,
  };
  return { sheets: [sheet], generator: "stdlib-dsv" };
}

/**
 * Rows of actual data: the grid minus the header row. This is the count every
 * user-facing surface states, and the index space `--rows A:B` slices over — a
 * dimension line that quoted grid rows instead made an agent slice one row
 * short (QA 2026-07-24, OBS-1).
 */
export function dataRowCount(sheet: TableSheet): number {
  const dataStart = sheet.headerRow !== null ? sheet.headerRow + 1 : 0;
  return Math.max(0, sheet.nRows - dataStart);
}

/** Reassemble one sheet's rows as arrays of display strings (null = empty). */
function rowsOf(sheet: TableSheet): Array<Array<string | null>> {
  const grid: Array<Array<string | null>> = [];
  for (let r = 0; r < sheet.nRows; r++) {
    grid.push(new Array<string | null>(sheet.nCols).fill(null));
  }
  for (const cell of sheet.cells) {
    const gridRow = grid[cell.rowIndex];
    if (gridRow && cell.colIndex < sheet.nCols) {
      gridRow[cell.colIndex] = cell.value;
    }
  }
  return grid;
}

/** Escape a cell for GitHub-flavored Markdown table rendering. */
function mdEscape(s: string | null): string {
  if (s == null) return "";
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * The eager default view: one Markdown section per sheet — name, dimensions,
 * schema line, and a table. Large tables show the first HEAD_ROWS and last
 * TAIL_ROWS with an explicit omission marker stating the TRUE total, so a
 * reader can never mistake a truncated view for the whole sheet.
 */
export function renderTableMarkdown(
  parsed: ParsedTable,
  attachmentName: string,
): string {
  const out: string[] = [];
  out.push(`# Tabular view: ${attachmentName}`);
  out.push("");
  for (const sheet of parsed.sheets) {
    out.push(
      `## Sheet: ${sheet.name}  (${dataRowCount(sheet)} rows × ${sheet.nCols} cols)`,
    );
    if (sheet.nRows === 0 || sheet.nCols === 0) {
      out.push("");
      out.push("_(empty sheet)_");
      out.push("");
      continue;
    }
    const schema = sheet.columns
      .map((c) => `${c.header ?? `col${c.colIndex}`}:${c.nativeType}`)
      .join(", ");
    out.push(`schema: ${schema}`);
    out.push("");

    const grid = rowsOf(sheet);
    const headerRow = sheet.headerRow;
    const headerGridRow = headerRow !== null ? grid[headerRow] : undefined;
    const headerCells =
      headerGridRow !== undefined
        ? headerGridRow.map((v, i) => v ?? `col${i}`)
        : sheet.columns.map((c) => `col${c.colIndex}`);

    const dataStart = headerRow !== null ? headerRow + 1 : 0;
    const dataRows = grid.slice(dataStart);
    const total = dataRows.length;

    out.push("| " + headerCells.map(mdEscape).join(" | ") + " |");
    out.push("| " + headerCells.map(() => "---").join(" | ") + " |");

    const emit = (r: Array<string | null>) =>
      out.push("| " + r.map(mdEscape).join(" | ") + " |");

    if (total <= INLINE_ROW_CAP) {
      for (const r of dataRows) emit(r);
    } else {
      for (const r of dataRows.slice(0, HEAD_ROWS)) emit(r);
      const omitted = total - HEAD_ROWS - TAIL_ROWS;
      out.push(
        `| _… ${omitted} rows omitted (true total: ${total} data rows). ` +
          `Use 'mail table <id> --sheet ${JSON.stringify(sheet.name)} --rows A:B' for any slice. …_ |`,
      );
      for (const r of dataRows.slice(total - TAIL_ROWS)) emit(r);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}
