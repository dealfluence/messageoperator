import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  alertChips,
  buildActivityStructured,
  detailLine,
  outcomeChips,
  readBrokerStatus,
  stepTimings,
} from "../src/apps/outcomes.js";
import type { LedgerRecord } from "../src/ledger.js";

function rec(
  op: string,
  details: Record<string, unknown> = {},
  sha: string | null = "abc123def456",
): LedgerRecord {
  return { ts: new Date().toISOString(), actor: "broker", op, sha, details };
}

describe("outcomeChips", () => {
  it("maps the user-meaningful ledger ops to chips", () => {
    const chips = outcomeChips([
      rec("send_executed", { recipients: ["a@b.com"], channel: "gmail" }),
      rec("send_simulated", { recipients: ["c@d.com"] }),
      rec("send_rejected", { reason: "recipient_not_allowed" }),
      rec("folder_change_executed", {
        op: "archive",
        path: "accounts/x/mail/INBOX/cur/1.eml",
      }),
      rec("pack_executed", { edits_applied: 4, docx: "attachments/s/c.docx" }),
      rec("fetch_executed", { path: "accounts/x/mail/.Cache/cur/2.eml" }),
      rec("login_started", { account: "u@example.com" }),
      rec("draft_created"),
    ]);
    expect(chips.map((c) => c.kind)).toEqual([
      "sent",
      "simulated",
      "rejected",
      "archived",
      "packed",
      "fetched",
      "login",
      "draft",
    ]);
    expect(chips[0]!.text).toBe("Sent to a@b.com");
    expect(chips[2]!.text).toContain("recipient_not_allowed");
    expect(chips[3]!.text).toBe("Archived 1.eml");
    expect(chips[4]!.text).toContain("4 tracked change(s)");
  });

  it("skips internal ops (tags, audits, evictions, noops)", () => {
    const chips = outcomeChips([
      rec("tag"),
      rec("untag"),
      rec("state_diff"),
      rec("body_evicted"),
      rec("fetch_noop"),
      rec("settings_opened"),
    ]);
    expect(chips).toEqual([]);
  });

  /**
   * QA 2026-07-24, BUG-2 (medium), second surface: the same DraftBox blind spot
   * as sendOutcomeLines() in broker.ts. `draft_created` (a LOCAL draft) has a
   * chip, but a draft actually filed in the provider's Drafts folder — or
   * rejected, or deleted — renders nothing at all, so the activity card shows a
   * cycle in which "nothing happened".
   */
  it("chips provider-draft outcomes (QA 2026-07-24 BUG-2)", () => {
    const chips = outcomeChips([
      rec("draft_uploaded", { account: "a@b.com", channel: "gmail" }),
      rec("draft_upload_simulated", { account: "a@b.com", channel: "gmail" }),
      rec("draft_rejected", { account: "a@b.com", reason: "sha_mismatch" }),
      rec("draft_deleted", { account: "a@b.com", result: "applied" }),
    ]);
    expect(chips).toHaveLength(4);
    expect(chips.map((c) => c.kind)).toEqual([
      "draft",
      "simulated",
      "rejected",
      "draft",
    ]);
    expect(chips[2]!.text).toContain("sha_mismatch");
  });

  it("labels unarchive distinctly", () => {
    const chips = outcomeChips([
      rec("folder_change_executed", { op: "unarchive", path: "a/b/2.eml" }),
    ]);
    expect(chips[0]).toEqual({ kind: "unarchived", text: "Unarchived 2.eml" });
  });

  it("truncates beyond the cap with a +N more chip", () => {
    const many = Array.from({ length: 20 }, () =>
      rec("send_executed", { recipients: ["a@b.com"] }),
    );
    const chips = outcomeChips(many);
    expect(chips).toHaveLength(12);
    expect(chips[11]!.kind).toBe("more");
    expect(chips[11]!.text).toContain("+9 more");
  });
});

describe("alertChips / readBrokerStatus", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("returns [] for a missing or unparsable status file", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailroom-outcomes-"));
    expect(readBrokerStatus(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, ".broker-status.json"), "{nope");
    expect(readBrokerStatus(dir)).toBeNull();
    expect(alertChips(null)).toEqual([]);
  });

  it("surfaces dry run, auth trouble, and queued sends", () => {
    const chips = alertChips({
      dry_run: true,
      pending_intents: 2,
      auth: {
        "ok@example.com": "ok",
        "unverified@example.com": "ok_unverified",
        "stuck@example.com": "needs_login",
        "gmail@example.com": "no_app_password",
      },
    });
    expect(chips.map((c) => c.kind)).toEqual([
      "dry_run",
      "auth",
      "auth",
      "queued",
    ]);
    expect(chips[1]!.text).toBe("stuck@example.com: needs login");
    expect(chips[3]!.text).toContain("2 queued send(s)");
  });
});

describe("buildActivityStructured", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("assembles the activity payload from records and status", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailroom-outcomes-"));
    fs.writeFileSync(
      path.join(dir, ".broker-status.json"),
      JSON.stringify({ dry_run: true, pending_intents: 0, auth: {} }),
    );
    const startedAt = Date.now() - 1000;
    const sc = buildActivityStructured({
      seq: 7,
      tool: "mailroom_bash",
      startedAt,
      ok: true,
      records: [rec("send_simulated", { recipients: ["x@y.com"] })],
      steps: [
        { label: "running command", startedAt, endedAt: startedAt + 800 },
      ],
      detail: "$ mail   send\n draft.eml",
      exitCode: 0,
      roomDir: dir,
    });
    expect(sc.view).toBe("activity");
    expect(sc.seq).toBe(7);
    expect(sc.createdAt).toBe(startedAt);
    expect(sc.endedAt).toBeGreaterThanOrEqual(startedAt);
    expect(sc.dryRun).toBe(true);
    expect(sc.outcomes[0]!.kind).toBe("simulated");
    expect(sc.alerts[0]!.kind).toBe("dry_run");
    expect(sc.steps).toEqual([{ label: "running command", ms: 800 }]);
    expect(sc.detail).toBe("$ mail send draft.eml"); // whitespace collapsed
    expect(sc.exitCode).toBe(0);
    // stays tiny: the whole payload must never threaten the result budget
    expect(JSON.stringify(sc).length).toBeLessThan(2000);
  });

  it("works without a status file (no alerts, no dryRun key)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailroom-outcomes-"));
    const sc = buildActivityStructured({
      seq: 1,
      tool: "mailroom_view",
      startedAt: Date.now(),
      ok: true,
      records: [],
      steps: [],
      roomDir: dir,
    });
    expect(sc.alerts).toEqual([]);
    expect(sc.outcomes).toEqual([]);
    expect(sc.steps).toEqual([]);
    expect("dryRun" in sc).toBe(false);
    expect("detail" in sc).toBe(false);
    expect("exitCode" in sc).toBe(false);
  });
});

describe("detailLine", () => {
  it("collapses whitespace and caps at 120 chars with an ellipsis", () => {
    expect(detailLine("  a \n\t b  ")).toBe("a b");
    const long = detailLine("$ " + "x".repeat(300));
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("stepTimings", () => {
  it("computes durations, treats an unclosed step as zero, and caps at 10", () => {
    const t0 = 1_000_000;
    const many = Array.from({ length: 15 }, (_, i) => ({
      label: `s${i}`,
      startedAt: t0,
      endedAt: t0 + i,
    }));
    expect(stepTimings(many)).toHaveLength(10);
    expect(stepTimings([{ label: "open", startedAt: t0 }])).toEqual([
      { label: "open", ms: 0 },
    ]);
  });
});
