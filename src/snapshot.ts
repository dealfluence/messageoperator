/**
 * Room-state snapshots and the diff audit.
 *
 * Each broker cycle writes a manifest (path -> sha) of everything under
 * accounts/. Changes not attributable to known operations this cycle are
 * ledgered as `state_diff`. A (mtimeMs, size) -> sha cache keeps unchanged
 * files stat-only; the audit is a tripwire, not a security boundary.
 */

import fs from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import { ownAddresses } from "./config.js";
import type { Layout } from "./layout.js";
import { sha12 } from "./layout.js";
import type { Ledger } from "./ledger.js";

const LATEST = "manifest-latest.json";
const HASH_CACHE = "manifest-hash-cache.json";
export const STATUS_FILE = ".broker-status.json"; // in room/, readable by the agent

export type Manifest = Record<string, string>;
export type HashCache = Record<string, [number, number, string]>;

export interface StatusExtras {
  pendingIntents: number;
  networkSynced: boolean;
  lastNetworkSync: string | null;
  mode: string;
  auth: Record<string, string>;
  /**
   * The always-allowed recipient set to publish. The broker passes only
   * AUTHENTICATED accounts (see processOutboxes); defaults to all configured
   * addresses.
   */
  ownAddresses?: string[];
  /** address -> live sign-in URL while a loopback login flow is pending */
  authUrls?: Record<string, string>;
  /** advisory sentences for the agent/user (e.g. restart-required) */
  notices?: string[];
  /** address -> effective Microsoft app (client) id, masked, with source */
  msClientIds?: Record<string, { suffix: string; source: string }>;
}

/**
 * Publish broker state into the room so `mail status`/`mail send` can tell
 * the agent the truth. Lives at room/.broker-status.json — outside
 * accounts/, so it never trips the diff audit.
 */
export function writeStatus(
  layout: Layout,
  cfg: Config,
  extras: StatusExtras,
): void {
  const now = new Date().toISOString();
  const status = {
    ts: now,
    mode: extras.mode, // "boundary": tool-call edges; "daemon": poll loop
    dry_run: cfg.dry_run,
    own_addresses: extras.ownAddresses ?? [...ownAddresses(cfg)].sort(),
    allowed_recipient_domains: [...cfg.policy.allowed_recipient_domains].sort(),
    // Mailboxes with a local maildir. NOT the same as "still connected":
    // removing an account keeps its mail by default, so a removed mailbox
    // stays in this list for as long as its files do.
    accounts: layout.accountAddresses(),
    // Mailboxes the broker actually syncs, straight from config. The room
    // needs this to tell live mail from a removed mailbox's local archive;
    // `accounts` above cannot answer that.
    connected_accounts: cfg.accounts.map((a) => a.address).sort(),
    max_sends_per_hour: cfg.policy.max_sends_per_hour,
    pending_intents: extras.pendingIntents,
    last_network_sync: extras.networkSynced ? now : extras.lastNetworkSync,
    pull_interval_seconds: cfg.pull_interval_seconds,
    auth: extras.auth,
    auth_urls: extras.authUrls ?? {},
    // e.g. "extension settings changed after this server started — restart";
    // mail status prints each one, so the agent can relay it to the user
    notices: extras.notices ?? [],
    ms_client_ids: extras.msClientIds ?? {},
  };
  fs.mkdirSync(layout.room, { recursive: true });
  const tmp = path.join(layout.room, STATUS_FILE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
  fs.renameSync(tmp, path.join(layout.room, STATUS_FILE));
}

export function countPendingIntents(layout: Layout): number {
  let total = 0;
  for (const address of layout.accountAddresses()) {
    const outboxNew = path.join(
      layout.accounts,
      address,
      "mail",
      "Outbox",
      "new",
    );
    let entries: string[];
    try {
      entries = fs.readdirSync(outboxNew);
    } catch {
      continue;
    }
    total += entries.filter(
      (n) => n.endsWith(".intent.json") || n.endsWith(".intent.sending"),
    ).length;
  }
  return total;
}

export function loadHashCache(layout: Layout): HashCache {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(layout.snapshots, HASH_CACHE), "utf-8"),
    );
    return typeof data === "object" && data !== null ? data : {};
  } catch {
    return {};
  }
}

export function saveHashCache(layout: Layout, cache: HashCache): void {
  fs.mkdirSync(layout.snapshots, { recursive: true });
  const tmp = path.join(layout.snapshots, HASH_CACHE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, path.join(layout.snapshots, HASH_CACHE));
}

function* walkFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Manifest of accounts/. With a cache, unchanged files (same mtime and
 * size) are not re-read; the cache is updated in place and pruned.
 */
export function buildManifest(layout: Layout, cache?: HashCache): Manifest {
  const manifest: Manifest = {};
  if (!fs.existsSync(layout.accounts)) {
    if (cache) for (const key of Object.keys(cache)) delete cache[key];
    return manifest;
  }
  for (const file of walkFiles(layout.accounts)) {
    const rel = layout.rel(file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // deleted mid-walk; next cycle sees the truth
    }
    const mtime = stat.mtimeMs;
    if (cache) {
      const entry = cache[rel];
      if (entry && entry[0] === mtime && entry[1] === stat.size) {
        manifest[rel] = entry[2];
        continue;
      }
    }
    let sha: string;
    try {
      sha = sha12(fs.readFileSync(file));
    } catch {
      continue;
    }
    manifest[rel] = sha;
    if (cache) cache[rel] = [mtime, stat.size, sha];
  }
  if (cache) {
    for (const stale of Object.keys(cache)) {
      if (!(stale in manifest)) delete cache[stale];
    }
  }
  return manifest;
}

export function loadPrevious(layout: Layout): Manifest | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(layout.snapshots, LATEST), "utf-8"),
    );
  } catch {
    return null;
  }
}

/**
 * Update LATEST; keep a dated copy only when something changed (boundary
 * cycles run per tool call — an unconditional copy would pile up fast).
 */
export function save(
  layout: Layout,
  manifest: Manifest,
  previous: Manifest | null,
): void {
  fs.mkdirSync(layout.snapshots, { recursive: true });
  const payload = JSON.stringify(manifest, Object.keys(manifest).sort(), 1);
  if (!manifestsEqual(manifest, previous)) {
    // millisecond stamp: boundary cycles can change state twice within the
    // same second, and each change deserves its own snapshot
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "T");
    fs.writeFileSync(
      path.join(layout.snapshots, `manifest-${stamp}.json`),
      payload,
    );
  }
  fs.writeFileSync(path.join(layout.snapshots, LATEST), payload);
}

function manifestsEqual(a: Manifest, b: Manifest | null): boolean {
  if (b === null) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

/** Ledger a state_diff for manifest changes outside known operations. */
export function diffAudit(
  layout: Layout,
  ledger: Ledger,
  previous: Manifest | null,
  current: Manifest,
  explained: Set<string>,
): void {
  if (previous === null) return; // first cycle establishes the baseline
  const added = Object.keys(current).filter(
    (p) => !(p in previous) && !explained.has(p),
  );
  const removed = Object.keys(previous).filter(
    (p) => !(p in current) && !explained.has(p),
  );
  const modified = Object.keys(current).filter(
    (p) => p in previous && current[p] !== previous[p] && !explained.has(p),
  );
  if (added.length || removed.length || modified.length) {
    ledger.append(
      "state_diff",
      {
        added: added.sort(),
        removed: removed.sort(),
        modified: modified.sort(),
        note: "room state changed outside known operations",
      },
      { actor: "agent" },
    );
  }
}
