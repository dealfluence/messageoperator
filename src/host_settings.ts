/**
 * Restart-required detection for extension-pane settings.
 *
 * The MCP host injects our settings as env vars at spawn
 * (MESSAGEOPERATOR_MS_CLIENT_ID, ...), so a settings-pane edit reaches this
 * process only after the host restarts the server. Before this module, that
 * failure mode was silent: the user changed a value, nothing happened, and
 * the stale one kept being used.
 *
 * Two independent, best-effort signals:
 *
 *  1. probeHostSettings() — when the host keeps a per-extension settings
 *     file on disk (Claude Desktop does: `Claude Extensions Settings/
 *     <id>.messageoperator.json`), an mtime newer than our spawn means the
 *     user edited our settings after this server started. When the file's
 *     values are readable we compare them against our env and name the
 *     exact stale setting; when not, we say so generically.
 *
 *  2. recordEnvSnapshot() — remembers the env the host injected across
 *     restarts (broker/env-snapshot.json), so the first cycle after a
 *     relaunch can announce "new client id picked up" and the user gets
 *     positive confirmation instead of guessing.
 *
 * IMPORTANT: this server may run under any MCP host, not just Claude
 * Desktop. Every signal degrades to silence when the host leaves no
 * settings file, and no wording ever assumes the host — Claude Desktop is
 * only named conditionally ("if this server runs inside Claude Desktop…").
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanEnvValue, maskClientId } from "./config.js";

/** Spawn time approximated at module load; Node has no direct API for it. */
const SPAWN_MS = Date.now() - process.uptime() * 1000;

/** extension-pane user_config key -> the env var the host injects it as */
const PANE_KEYS: Record<string, string> = {
  microsoft_client_id: "MESSAGEOPERATOR_MS_CLIENT_ID",
  dry_run: "MESSAGEOPERATOR_DRY_RUN",
  allowed_recipient_domains: "MESSAGEOPERATOR_ALLOWED_RECIPIENT_DOMAINS",
  state_home: "MESSAGEOPERATOR_HOME",
};

const RESTART_HINT =
  "Restart the MCP server to apply it — if this server runs inside " +
  "Claude Desktop, fully quit and reopen the app; under another host, " +
  "restart that host's MCP server.";

export interface HostSettingsProbe {
  /** The host's per-extension settings file, when one was found. */
  file: string | null;
  /** That file was modified after this process started. */
  changedSinceSpawn: boolean;
  /** The pane's microsoft_client_id, when readable from the file. */
  paneClientId?: string;
  /**
   * Definitive: the pane sets a Microsoft client id different from the env
   * this process was started with (and the edit postdates our spawn).
   */
  staleClientId: boolean;
  /** Ready-to-print advisory sentences; empty = nothing to report. */
  notices: string[];
}

const SILENT: HostSettingsProbe = {
  file: null,
  changedSinceSpawn: false,
  staleClientId: false,
  notices: [],
};

/** Claude Desktop's per-extension settings directories, by platform. */
function defaultSettingsDirs(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [path.join(appData, "Claude", "Claude Extensions Settings")];
  }
  if (process.platform === "darwin") {
    return [
      path.join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "Claude Extensions Settings",
      ),
    ];
  }
  return [path.join(home, ".config", "Claude", "Claude Extensions Settings")];
}

/**
 * Find a pane value by key anywhere in the host's settings JSON. The file's
 * shape belongs to the host and may change between versions, so this is a
 * tolerant deep search rather than a fixed path.
 */
function findPaneValue(
  node: unknown,
  key: string,
  depth = 0,
): string | undefined {
  if (depth > 6 || typeof node !== "object" || node === null) return undefined;
  const rec = node as Record<string, unknown>;
  if (!Array.isArray(node) && key in rec) {
    const v = rec[key];
    if (
      typeof v === "string" ||
      typeof v === "boolean" ||
      typeof v === "number"
    ) {
      return String(v);
    }
    if (typeof v === "object" && v !== null) {
      const inner = (v as Record<string, unknown>).value;
      if (typeof inner === "string" || typeof inner === "boolean") {
        return String(inner);
      }
    }
    return undefined;
  }
  for (const child of Object.values(rec)) {
    const found = findPaneValue(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function valuesMatch(key: string, pane: string, live: string): boolean {
  if (key === "dry_run") {
    return pane.trim().toLowerCase() === live.trim().toLowerCase();
  }
  return pane.trim() === live.trim();
}

/**
 * Probe the host's settings store for edits this process has not received.
 * Every notice is gated on the file changing AFTER our spawn: an on-disk
 * value that merely differs from our env is NOT reported, because that is
 * exactly what running under a different harness looks like.
 */
export function probeHostSettings(
  opts: { env?: NodeJS.ProcessEnv; dirs?: string[]; spawnMs?: number } = {},
): HostSettingsProbe {
  const env = opts.env ?? process.env;
  const dirs = opts.dirs ?? defaultSettingsDirs();
  const spawnMs = opts.spawnMs ?? SPAWN_MS;

  let file: string | null = null;
  let mtimeMs = -Infinity;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.messageoperator\.json$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > mtimeMs) {
          mtimeMs = stat.mtimeMs;
          file = full;
        }
      } catch {
        // racing the host's own writes; next cycle sees the truth
      }
    }
  }
  if (!file) return SILENT; // unknown host or no settings store: no signal

  const changedSinceSpawn = mtimeMs > spawnMs;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    // unreadable: fall back to the mtime-only signal
  }
  const comparisons: { key: string; pane: string; live: string }[] = [];
  if (typeof parsed === "object" && parsed !== null) {
    for (const [paneKey, envName] of Object.entries(PANE_KEYS)) {
      const pane = findPaneValue(parsed, paneKey);
      if (pane === undefined) continue;
      comparisons.push({
        key: paneKey,
        pane,
        live: cleanEnvValue(env, envName) ?? "",
      });
    }
  }
  const paneClientId = comparisons.find(
    (c) => c.key === "microsoft_client_id",
  )?.pane;

  const result: HostSettingsProbe = {
    file,
    changedSinceSpawn,
    ...(paneClientId !== undefined ? { paneClientId } : {}),
    staleClientId: false,
    notices: [],
  };
  if (!changedSinceSpawn) return result;

  const mismatches = comparisons.filter(
    (c) => !valuesMatch(c.key, c.pane, c.live),
  );
  for (const m of mismatches) {
    if (m.key === "microsoft_client_id") {
      result.staleClientId = true;
      result.notices.push(
        "The extension settings now set Microsoft app (client) ID " +
          `${maskClientId(m.pane)}, but this server is still running with ` +
          `${maskClientId(m.live)} — settings are injected when the server ` +
          `starts. ${RESTART_HINT}`,
      );
    } else {
      result.notices.push(
        `The extension setting '${m.key}' was changed after this server ` +
          `started and is not yet in effect. ${RESTART_HINT}`,
      );
    }
  }
  if (!comparisons.length) {
    // the file changed but we could not read any values out of it: say so
    // generically rather than staying silent about a probable stale env
    result.notices.push(
      "This extension's settings were modified after this server started; " +
        `edits do not reach a running server. ${RESTART_HINT}`,
    );
  }
  return result;
}

/** env vars whose arrival is worth confirming across restarts */
const TRACKED_ENV = [
  "MESSAGEOPERATOR_MS_CLIENT_ID",
  "MESSAGEOPERATOR_DRY_RUN",
  "MESSAGEOPERATOR_ALLOWED_RECIPIENT_DOMAINS",
  "MESSAGEOPERATOR_GMAIL_ADDRESS",
  "MESSAGEOPERATOR_MS_ADDRESS",
] as const;

function displayEnvValue(name: string, value: string): string {
  if (!value) return "(not set)";
  return name === "MESSAGEOPERATOR_MS_CLIENT_ID" ? maskClientId(value) : value;
}

/**
 * Remember the host-injected env across restarts so the first cycle after a
 * relaunch can announce which settings changes actually arrived. Returns
 * human-readable change descriptions; [] on the first run (baseline write)
 * and when nothing changed. The file holds no secrets — only the same
 * values already visible in the process environment and config.json.
 */
export function recordEnvSnapshot(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  let previous: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof parsed === "object" && parsed !== null) {
      previous = parsed as Record<string, unknown>;
    }
  } catch {
    previous = null;
  }
  const current: Record<string, string> = {};
  for (const name of TRACKED_ENV) {
    current[name] = cleanEnvValue(env, name) ?? "";
  }
  const changes: string[] = [];
  if (previous) {
    for (const name of TRACKED_ENV) {
      const before = String(previous[name] ?? "");
      const after = current[name] ?? "";
      if (before === after) continue;
      changes.push(
        `${name} is now ${displayEnvValue(name, after)} ` +
          `(was ${displayEnvValue(name, before)})`,
      );
    }
  }
  if (!previous || changes.length) {
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
  }
  return previous ? changes : [];
}
