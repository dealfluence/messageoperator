/** Append-only JSONL audit ledger (broker/ledger.jsonl). */

import fs from "node:fs";
import path from "node:path";

export interface LedgerRecord {
  ts: string;
  actor: string;
  op: string;
  sha: string | null;
  details: Record<string, unknown>;
}

export class Ledger {
  constructor(readonly path: string) {}

  append(
    op: string,
    details: Record<string, unknown> = {},
    opts: { actor?: string; sha?: string | null } = {},
  ): LedgerRecord {
    const record: LedgerRecord = {
      ts: new Date().toISOString(),
      actor: opts.actor ?? "broker",
      op,
      sha: opts.sha ?? null,
      details,
    };
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.appendFileSync(this.path, JSON.stringify(record) + "\n");
    return record;
  }

  readAll(): LedgerRecord[] {
    let text: string;
    try {
      text = fs.readFileSync(this.path, "utf-8");
    } catch {
      return [];
    }
    return parse(text);
  }

  /** Current end of the ledger, for readSince(). */
  tailOffset(): number {
    try {
      return fs.statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  /**
   * Records appended after a tailOffset() marker — how a boundary push
   * reports what it just did without re-reading the whole file.
   */
  readSince(offset: number): LedgerRecord[] {
    let fd: number;
    try {
      fd = fs.openSync(this.path, "r");
    } catch {
      return [];
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return [];
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      return parse(buf.toString("utf-8"));
    } finally {
      fs.closeSync(fd);
    }
  }
}

function parse(text: string): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      /* skip unparseable line */
    }
  }
  return records;
}
