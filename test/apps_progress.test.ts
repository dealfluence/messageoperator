import { describe, expect, it } from "vitest";

import { ProgressTracker } from "../src/apps/progress.js";

describe("ProgressTracker", () => {
  it("is idle before begin and step() is a no-op", () => {
    const t = new ProgressTracker();
    t.step("should not appear");
    const snap = t.snapshot();
    expect(snap.active).toBe(false);
    expect(snap.current).toBe("idle");
    expect(snap.steps).toEqual([]);
  });

  it("tracks steps, closing the previous one on each step()", () => {
    const t = new ProgressTracker();
    const seq = t.begin("mailroom_bash");
    expect(seq).toBe(1);
    t.step("pulling new mail");
    t.step("running command");
    const snap = t.snapshot();
    expect(snap.active).toBe(true);
    expect(snap.tool).toBe("mailroom_bash");
    expect(snap.current).toBe("running command");
    expect(snap.steps).toHaveLength(2);
    expect(snap.steps[0]!.endedAt).toBeTypeOf("number");
    expect(snap.steps[1]!.endedAt).toBeUndefined();
  });

  it("end() closes the last step and deactivates", () => {
    const t = new ProgressTracker();
    t.begin("mailroom_view");
    t.step("reading");
    t.end();
    const snap = t.snapshot();
    expect(snap.active).toBe(false);
    expect(snap.current).toBe("idle");
    expect(snap.steps[0]!.endedAt).toBeTypeOf("number");
  });

  it("begin() resets steps and increments seq", () => {
    const t = new ProgressTracker();
    t.begin("a");
    t.step("one");
    t.end();
    const seq = t.begin("b");
    expect(seq).toBe(2);
    expect(t.snapshot().steps).toEqual([]);
    expect(t.snapshot().tool).toBe("b");
  });

  it("caps recorded steps so a runaway loop cannot grow the snapshot", () => {
    const t = new ProgressTracker();
    t.begin("a");
    for (let i = 0; i < 100; i++) t.step(`step ${i}`);
    expect(t.snapshot().steps.length).toBeLessThanOrEqual(40);
  });

  it("snapshots are stable copies, not live references", () => {
    const t = new ProgressTracker();
    t.begin("a");
    t.step("one");
    const snap = t.snapshot();
    t.step("two");
    expect(snap.steps).toHaveLength(1);
    expect(snap.steps[0]!.endedAt).toBeUndefined();
  });
});
