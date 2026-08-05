// FILE: src/tabular_store.ts
/**
 * SQLite sidecar writer for tabular attachments.
 *
 * Takes a ParsedTable (src/tabular.ts) and writes the `.tabular.db` sidecar
 * that the in-room `mail table` verb reads (read-only, stdlib sqlite3) to
 * serve slices, projections, records/JSONL/CSV output, and values-vs-formulas
 * — all WITHOUT re-parsing the binary or crossing the machine boundary.
 *
 * This is the cross-wall data contract. The schema is fixed and versioned;
 * `mail.py` reads exactly these tables. Written on node:sqlite (DatabaseSync)
 * — the same builtin src/db.ts and src/state.ts use — via the getBuiltinModule
 * loader (bundlers don't all resolve the prefix-only builtin). Delivery is
 * atomic: build in a temp file, then rename into place, so a half-written
 * sidecar is never observable.
 *
 * The full table is always stored (no row cap here); truncation is a VIEW
 * concern handled in tabular.ts. A tens-of-thousands-row sheet lives complete
 * in the sidecar so any slice the truncated .md points at is actually there.
 */

import fs from "node:fs";
import path from "node:path";

import type { ParsedTable } from "./tabular.js";

/** Bumped only on an incompatible sidecar schema change; mail.py checks it. */
export const SIDECAR_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE sheets (
  sheet_index INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  n_rows      INTEGER NOT NULL,
  n_cols      INTEGER NOT NULL,
  header_row  INTEGER            -- best-guess header row index, NULL if unknown
);

CREATE TABLE columns (
  sheet_index INTEGER NOT NULL,
  col_index   INTEGER NOT NULL,
  header      TEXT,              -- best-guess header text, NULL if none
  native_type TEXT NOT NULL,     -- dominant SheetJS type in the column
  PRIMARY KEY (sheet_index, col_index)
);

CREATE TABLE cells (
  sheet_index INTEGER NOT NULL,
  row_index   INTEGER NOT NULL,
  col_index   INTEGER NOT NULL,
  value       TEXT,              -- formatted display text (SheetJS .w)
  value_raw   TEXT,              -- raw underlying value (SheetJS .v, stringified)
  native_type TEXT NOT NULL,     -- per-cell SheetJS type verbatim
  formula     TEXT,              -- SheetJS .f without '=', NULL if none
  PRIMARY KEY (sheet_index, row_index, col_index)
);
-- slicing/projection support: the hot query is a row range within one sheet
CREATE INDEX idx_cells_slice ON cells(sheet_index, row_index, col_index);
`;

function sqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule?.("node:sqlite");
  if (!mod) {
    throw new Error(
      "the built-in 'node:sqlite' module is unavailable — Message Operator needs Node 22.13+ (24 recommended)",
    );
  }
  return mod;
}

export interface WriteSidecarOpts {
  sourceSha: string; // content sha of the raw attachment
  sourceName: string; // original attachment filename
}

/**
 * Write `parsed` to a `.tabular.db` at `destPath` (atomically). Overwrites any
 * existing file at that path. Throws on any SQLite error — the caller isolates
 * the failure to this one attachment, exactly as a malformed PDF view does.
 */
export function writeTabularSidecar(
  destPath: string,
  parsed: ParsedTable,
  opts: WriteSidecarOpts,
): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.${process.pid}.tmp`;
  // a stale temp from a previous crashed write must never be appended to
  fs.rmSync(tmp, { force: true });

  const db = new (sqlite().DatabaseSync)(tmp);
  try {
    db.exec("PRAGMA journal_mode=MEMORY");
    db.exec("PRAGMA synchronous=OFF"); // sidecar is a rebuildable cache
    db.exec(DDL);

    const metaIns = db.prepare("INSERT INTO meta(key,value) VALUES(?,?)");
    metaIns.run("schema_version", String(SIDECAR_SCHEMA_VERSION));
    metaIns.run("source_sha", opts.sourceSha);
    metaIns.run("source_name", opts.sourceName);
    metaIns.run("generator", parsed.generator);

    const sheetIns = db.prepare(
      "INSERT INTO sheets(sheet_index,name,n_rows,n_cols,header_row) VALUES(?,?,?,?,?)",
    );
    const colIns = db.prepare(
      "INSERT INTO columns(sheet_index,col_index,header,native_type) VALUES(?,?,?,?)",
    );
    const cellIns = db.prepare(
      "INSERT INTO cells(sheet_index,row_index,col_index,value,value_raw,native_type,formula) " +
        "VALUES(?,?,?,?,?,?,?)",
    );

    db.exec("BEGIN");
    try {
      for (const sheet of parsed.sheets) {
        sheetIns.run(
          sheet.sheetIndex,
          sheet.name,
          sheet.nRows,
          sheet.nCols,
          sheet.headerRow, // number | null -> INTEGER | NULL
        );
        for (const col of sheet.columns) {
          colIns.run(
            sheet.sheetIndex,
            col.colIndex,
            col.header, // string | null
            col.nativeType,
          );
        }
        for (const cell of sheet.cells) {
          cellIns.run(
            sheet.sheetIndex,
            cell.rowIndex,
            cell.colIndex,
            cell.value, // string | null
            cell.valueRaw, // string | null
            cell.nativeType,
            cell.formula, // string | null
          );
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* connection may already be unusable */
      }
      throw err;
    }
  } finally {
    db.close();
  }

  fs.renameSync(tmp, destPath); // atomic within the same filesystem
}
