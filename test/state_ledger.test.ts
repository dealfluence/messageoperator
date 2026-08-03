import { describe, expect, it } from "vitest";

import { Ledger } from "../src/ledger.js";
import { makeLayout } from "./helpers.js";

// Index behavior (now SQLite-backed) is covered in state_sqlite.test.ts.

describe("Ledger", () => {
  it("appends and reads records; readSince honors the offset", () => {
    const layout = makeLayout();
    const ledger = new Ledger(layout.ledgerPath);
    ledger.append("first", { n: 1 });
    const offset = ledger.tailOffset();
    ledger.append("second", { n: 2 }, { actor: "agent", sha: "abc" });

    const all = ledger.readAll();
    expect(all.map((r) => r.op)).toEqual(["first", "second"]);
    const since = ledger.readSince(offset);
    expect(since).toHaveLength(1);
    expect(since[0]!.op).toBe("second");
    expect(since[0]!.actor).toBe("agent");
    expect(since[0]!.sha).toBe("abc");
  });

  it("is resilient to a missing file", () => {
    const layout = makeLayout();
    const ledger = new Ledger(layout.ledgerPath);
    expect(ledger.readAll()).toEqual([]);
    expect(ledger.tailOffset()).toBe(0);
    expect(ledger.readSince(0)).toEqual([]);
  });
});
