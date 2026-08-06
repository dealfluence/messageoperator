/**
 * Maps a push cycle's ledger slice and the broker status file into the
 * compact chips the activity app renders. Pure functions over data the
 * broker already produces — nothing here re-derives outcomes.
 */

import fs from "node:fs";
import path from "node:path";

import type { LedgerRecord } from "../ledger.js";
import type { ProgressStep } from "./progress.js";

export interface Chip {
  /** Stable slug the UI colors by (sent, simulated, rejected, archived, …). */
  kind: string;
  text: string;
}

/** A finished tracker step, reduced to what the card renders. */
export interface StepTiming {
  label: string;
  ms: number;
}

export interface ActivityStructured {
  view: "activity";
  seq: number;
  createdAt: number;
  endedAt: number;
  tool: string;
  ok: boolean;
  /** What actually ran, for the card's mono line: "$ mail status", "view skills/SKILL.md". */
  detail?: string;
  /** Shell exit code (messageoperator_bash only). */
  exitCode?: number;
  outcomes: Chip[];
  alerts: Chip[];
  attachments?: { name: string; path: string }[];
  steps: StepTiming[];
  dryRun?: boolean;
  [key: string]: unknown; // structuredContent must be JSON-object-shaped
}

const MAX_DETAIL_CHARS = 120;

/** Collapse whitespace and cap length for the card's one-line detail. */
export function detailLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL_CHARS
    ? flat.slice(0, MAX_DETAIL_CHARS - 1) + "…"
    : flat;
}

const MAX_OUTCOMES = 12;
const MAX_ALERTS = 6;
const MAX_STEPS = 10;

function base(p: unknown): string {
  return typeof p === "string" && p ? path.posix.basename(p) : "";
}

/** One chip per user-meaningful ledger op; internal ops are skipped. */
export function outcomeChips(records: LedgerRecord[]): Chip[] {
  const chips: Chip[] = [];
  for (const r of records) {
    const d = (r.details ?? {}) as Record<string, unknown>;
    const recipients = Array.isArray(d.recipients)
      ? (d.recipients as string[]).join(", ")
      : "";
    const reason = typeof d.reason === "string" ? d.reason : "unknown";
    const op = typeof d.op === "string" ? d.op : "change";
    switch (r.op) {
      case "send_executed":
        chips.push({ kind: "sent", text: `Sent to ${recipients || "?"}` });
        break;
      case "send_simulated":
        chips.push({
          kind: "simulated",
          text: `Simulated send to ${recipients || "?"} (dry run)`,
        });
        break;
      case "send_rejected":
        chips.push({ kind: "rejected", text: `Send rejected — ${reason}` });
        break;
      case "folder_change_executed":
        chips.push({
          kind: op === "unarchive" ? "unarchived" : "archived",
          text: `${op === "unarchive" ? "Unarchived" : "Archived"} ${base(d.path) || r.sha || "?"}`,
        });
        break;
      case "folder_change_simulated":
        chips.push({
          kind: "simulated",
          text: `Simulated ${op} of ${base(d.path) || r.sha || "?"} (dry run)`,
        });
        break;
      case "folder_change_rejected":
        chips.push({
          kind: "rejected",
          text: `${op === "unarchive" ? "Unarchive" : "Archive"} rejected — ${reason}`,
        });
        break;
      case "pack_executed":
        chips.push({
          kind: "packed",
          text: `${typeof d.edits_applied === "number" ? d.edits_applied : "?"} tracked change(s) packed into ${base(d.docx) || "the .docx"}`,
        });
        break;
      case "pack_rejected":
        chips.push({ kind: "rejected", text: `Pack rejected — ${reason}` });
        break;
      case "fetch_executed":
        chips.push({
          kind: "fetched",
          text: `Downloaded body ${r.sha ?? "?"}`,
        });
        break;
      case "fetch_rejected":
        chips.push({
          kind: "rejected",
          text: `Fetch rejected — ${reason} (${r.sha ?? "?"})`,
        });
        break;
      case "login_started":
        chips.push({
          kind: "login",
          text: `Sign-in page opened for ${typeof d.account === "string" ? d.account : "?"}`,
        });
        break;
      case "login_rejected":
        chips.push({
          kind: "rejected",
          text: `Login rejected for ${typeof d.address === "string" ? d.address : "?"} — ${reason}`,
        });
        break;
      case "draft_created":
        chips.push({ kind: "draft", text: "Draft saved" });
        break;
      // DraftBox: a draft filed with (or removed from) the provider. Distinct
      // from draft_created, which only wrote a local file in the room.
      case "draft_uploaded":
        chips.push({
          kind: "draft",
          text: `Draft filed in ${typeof d.channel === "string" ? d.channel : "the provider"} Drafts`,
        });
        break;
      case "draft_upload_simulated":
        chips.push({
          kind: "simulated",
          text: "Simulated draft upload (dry run)",
        });
        break;
      case "draft_rejected":
        chips.push({ kind: "rejected", text: `Draft rejected — ${reason}` });
        break;
      case "draft_deleted":
        chips.push({ kind: "draft", text: "Provider draft deleted" });
        break;
      case "draft_delete_simulated":
        chips.push({
          kind: "simulated",
          text: "Simulated draft delete (dry run)",
        });
        break;
      default:
        break; // tags, audits, evictions: internal noise for this card
    }
  }
  if (chips.length > MAX_OUTCOMES) {
    const extra = chips.length - (MAX_OUTCOMES - 1);
    return [
      ...chips.slice(0, MAX_OUTCOMES - 1),
      { kind: "more", text: `+${extra} more — see send_results` },
    ];
  }
  return chips;
}

interface BrokerStatus {
  dry_run?: boolean;
  pending_intents?: number;
  auth?: Record<string, string>;
  /** advisory sentences from the broker (e.g. restart-required) */
  notices?: string[];
}

/** Read room/.broker-status.json; absent or unparsable → null. */
export function readBrokerStatus(roomDir: string): BrokerStatus | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(roomDir, ".broker-status.json"), "utf-8"),
    ) as BrokerStatus;
  } catch {
    return null;
  }
}

export function alertChips(status: BrokerStatus | null): Chip[] {
  if (!status) return [];
  const chips: Chip[] = [];
  if (status.dry_run) {
    chips.push({
      kind: "dry_run",
      text: "Dry run is on — sends are simulated",
    });
  }
  for (const notice of status.notices ?? []) {
    chips.push({ kind: "notice", text: notice });
  }
  for (const [address, state] of Object.entries(status.auth ?? {})) {
    if (state === "ok" || state === "ok_unverified") continue;
    chips.push({
      kind: "auth",
      text: `${address}: ${state.replace(/_/g, " ")}`,
    });
  }
  if ((status.pending_intents ?? 0) > 0) {
    chips.push({
      kind: "queued",
      text: `${status.pending_intents} queued send(s) awaiting the next push`,
    });
  }
  return chips.slice(0, MAX_ALERTS);
}

/** Reduce finished tracker steps to card-renderable timings. */
export function stepTimings(steps: ProgressStep[]): StepTiming[] {
  return steps
    .map((s) => ({
      label: s.label,
      ms: Math.max(0, (s.endedAt ?? s.startedAt) - s.startedAt),
    }))
    .slice(0, MAX_STEPS);
}

export function buildActivityStructured(args: {
  seq: number;
  tool: string;
  startedAt: number;
  ok: boolean;
  detail?: string;
  exitCode?: number;
  records: LedgerRecord[];
  steps: ProgressStep[];
  attachments?: { name: string; path: string }[];
  roomDir: string;
}): ActivityStructured {
  const status = readBrokerStatus(args.roomDir);
  return {
    view: "activity",
    seq: args.seq,
    createdAt: args.startedAt,
    endedAt: Date.now(),
    tool: args.tool,
    ok: args.ok,
    ...(args.detail ? { detail: detailLine(args.detail) } : {}),
    ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
    outcomes: outcomeChips(args.records),
    alerts: alertChips(status),
    ...(args.attachments && args.attachments.length > 0
      ? { attachments: args.attachments }
      : {}),
    steps: stepTimings(args.steps),
    ...(status ? { dryRun: Boolean(status.dry_run) } : {}),
  };
}
