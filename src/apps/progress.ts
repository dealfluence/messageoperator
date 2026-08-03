/**
 * In-process progress channel for the activity app.
 *
 * The tool handler calls begin()/end() around a bash/view call; the broker
 * (and the handler itself) report coarse phases via step(). The app polls
 * the app-only mailroom_activity_progress tool, which returns snapshot().
 * Everything lives in memory: no files, no audit side effects, and reads
 * never contend with the broker's cycle lock. step() is a no-op while no
 * call is active, so daemon-mode broker cycles cost nothing.
 */

export interface ProgressStep {
  label: string;
  startedAt: number;
  endedAt?: number;
}

export interface ProgressSnapshot {
  active: boolean;
  seq: number;
  tool: string;
  startedAt: number;
  updatedAt: number;
  current: string;
  steps: ProgressStep[];
}

const MAX_STEPS = 40; // a runaway loop must not grow the snapshot unboundedly

export class ProgressTracker {
  private active = false;
  private seq = 0;
  private tool = "";
  private startedAt = 0;
  private updatedAt = 0;
  private steps: ProgressStep[] = [];

  /** Start tracking a tool call; returns its sequence number. */
  begin(tool: string): number {
    this.active = true;
    this.seq += 1;
    this.tool = tool;
    this.startedAt = Date.now();
    this.updatedAt = this.startedAt;
    this.steps = [];
    return this.seq;
  }

  /** Close the current step and open a new one. No-op when inactive. */
  step(label: string): void {
    if (!this.active) return;
    const now = Date.now();
    const last = this.steps[this.steps.length - 1];
    if (last && last.endedAt === undefined) last.endedAt = now;
    if (this.steps.length < MAX_STEPS) {
      this.steps.push({ label, startedAt: now });
    }
    this.updatedAt = now;
  }

  /** Mark the current call finished. */
  end(): void {
    if (!this.active) return;
    const now = Date.now();
    const last = this.steps[this.steps.length - 1];
    if (last && last.endedAt === undefined) last.endedAt = now;
    this.active = false;
    this.updatedAt = now;
  }

  snapshot(): ProgressSnapshot {
    return {
      active: this.active,
      seq: this.seq,
      tool: this.tool,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      current: this.active
        ? (this.steps[this.steps.length - 1]?.label ?? "working")
        : "idle",
      // steps are mutated in place; copy so a snapshot is a stable value
      steps: this.steps.map((s) => ({ ...s })),
    };
  }
}

/** Process-wide singleton: one server process, one tool call at a time. */
export const progress = new ProgressTracker();
