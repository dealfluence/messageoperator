/**
 * Broker: sync mail in, execute intents out, audit the room.
 *
 * Owns all credentials, the ledger, and the index. Shares nothing with the
 * MCP server except the filesystem.
 *
 * Boundary mode (`messageoperator serve`): no background service. pull() runs at
 * the start of a reading tool call (network sync, throttled) and push() at
 * the end of a mutating call (execute intents, fold tags, audit). The room
 * state only changes at tool-call edges.
 *
 * Logins are lazy and never block a tool call: a Microsoft account with no
 * cached token gets a loopback sign-in flow started during a pull — once
 * automatically per process, and again whenever the agent runs `mail login`
 * (which drops room/.login-request.json for the next cycle to pick up).
 * The flow resolves in the background when the browser redirect lands.
 *
 * One async lock serializes cycles: the MCP server can interleave tool
 * calls, and a cycle was never designed to overlap with itself.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type AccountConfig,
  type Config,
  appendAccountToFile,
  defaultMsClientId,
  ensureDefaultConfig,
  findAccount,
  dryRunSource,
  isValidAccountAddress,
  loadConfig,
  persistAccount,
  removeAccountFromFile,
  saveSettingsPage,
} from "./config.js";
import {
  gmailAppPassword,
  storeGmailAppPassword,
  deleteGmailAppPassword,
} from "./creds.js";
import * as gmail from "./gmail.js";
import { GmailSetupFlow } from "./gmail_setup.js";
import { SettingsPageFlow } from "./settings_page.js";
import * as intents from "./intents.js";
import { Layout, sha12 } from "./layout.js";
import { progress } from "./apps/progress.js";
import { Ledger, type LedgerRecord } from "./ledger.js";
import { log } from "./log.js";
import * as msgraph from "./msgraph.js";
import { asViewFile, packDocx } from "./pack.js";
import { storeFetchedBody } from "./store.js";
import { detectProvider } from "./provider.js";
import * as snapshot from "./snapshot.js";
import { Index } from "./state.js";

export const POLL_INTERVAL = 120; // seconds between network syncs (daemon mode)
export const TICK = 15; // seconds between local cycles (daemon mode)
/** per-cycle wall-clock budget for historical metadata backfill (spec: 2.5s) */
export const BACKFILL_BUDGET_MS = 2500;

const LOGIN_REQUEST_FILE = ".login-request.json"; // in room/, written by `mail login`
const ACCOUNT_REQUEST_FILE = ".account-request.json"; // in room/, written by `mail account add`
const FOLDER_REQUEST_FILE = ".folder-request.jsonl"; // in room/, written by `mail archive`/`mail unarchive`
const PACK_REQUEST_FILE = ".pack-request.jsonl"; // in room/, written by `mail pack`
const FETCH_REQUEST_FILE = ".fetch-request.jsonl"; // in room/, written by `mail fetch`
const SETTINGS_REQUEST_FILE = ".settings-request.json"; // in room/, written by `mail settings`
const PENDING_REMOVALS_FILE = "pending-removals.json"; // in broker/, written from the settings page

/**
 * Human sentences for the send outcomes in a slice of ledger records — what
 * a boundary push attaches to the tool result.
 */
export function sendOutcomeLines(records: LedgerRecord[]): string[] {
  const lines: string[] = [];
  for (const record of records) {
    const details = (record.details ?? {}) as {
      recipients?: string[];
      channel?: string;
      reason?: string;
      detail?: string;
      error?: string;
      op?: string;
      path?: string;
      result?: string;
      docx?: string;
      edits_applied?: number;
      message_id?: string;
    };
    const sha = record.sha ?? "?";
    const recipients = (details.recipients ?? []).join(", ") || "?";
    if (record.op === "send_executed") {
      lines.push(
        `SENT: ${sha} delivered to ${recipients} via ${details.channel ?? "?"} ` +
          "(ledger: send_executed)",
      );
    } else if (record.op === "send_simulated") {
      lines.push(
        `SIMULATED: ${sha} to ${recipients} — dry_run is on, no network call ` +
          "was made (ledger: send_simulated)",
      );
    } else if (record.op === "send_rejected") {
      const reason = details.reason ?? "?";
      const detail = details.detail ?? details.error ?? "";
      lines.push(
        `REJECTED (${reason}): ${detail} — the draft is back in Drafts/ ` +
          "with a .rejected.txt beside it",
      );
    } else if (record.op === "folder_change_executed") {
      lines.push(
        `${String(details.op ?? "change").toUpperCase()}D: ${details.path || sha} ` +
          `(provider result: ${details.result ?? "applied"}; ledger: folder_change_executed)`,
      );
    } else if (record.op === "folder_change_simulated") {
      lines.push(
        `SIMULATED ${String(details.op ?? "change").toUpperCase()}: ${details.path || sha} — ` +
          "dry_run is on, no provider-side change was made (ledger: folder_change_simulated)",
      );
    } else if (record.op === "folder_change_rejected") {
      lines.push(
        `${String(details.op ?? "change").toUpperCase()} REJECTED (${details.reason ?? "?"}): ` +
          `${details.detail ?? ""} — nothing was changed (${details.path || sha})`,
      );
      // DraftBox (`mail draft` / `mail draft-delete`): a provider-side draft is
      // never a send, but its outcome still has to surface here — send_results
      // is documented as the authoritative outcome, so a silent op reads as
      // "nothing happened" to the agent.
    } else if (record.op === "draft_uploaded") {
      lines.push(
        `DRAFT UPLOADED: ${sha} filed in the ${details.channel ?? "?"} ` +
          `Drafts folder as ${details.message_id ?? "?"} — it was NOT sent ` +
          "(ledger: draft_uploaded)",
      );
    } else if (record.op === "draft_upload_simulated") {
      lines.push(
        `SIMULATED DRAFT UPLOAD: ${sha} — dry_run is on, nothing was filed ` +
          "with the provider (ledger: draft_upload_simulated)",
      );
    } else if (record.op === "draft_rejected") {
      const reason = details.reason ?? "?";
      const detail = details.detail ?? details.error ?? "";
      lines.push(
        `DRAFT REJECTED (${reason}): ${detail} — nothing was filed with the ` +
          "provider (an upload is handed back to Drafts/ with a .rejected.txt " +
          "beside it)",
      );
    } else if (record.op === "draft_deleted") {
      lines.push(
        `DRAFT DELETED: ${details.message_id ?? sha} moved to the provider's ` +
          `Trash / Deleted Items (provider result: ${details.result ?? "applied"}; ` +
          "ledger: draft_deleted)",
      );
    } else if (record.op === "draft_delete_simulated") {
      lines.push(
        `SIMULATED DRAFT DELETE: ${details.message_id ?? sha} — dry_run is on, ` +
          "no provider-side change was made (ledger: draft_delete_simulated)",
      );
    } else if (record.op === "pack_executed") {
      lines.push(
        `PACKED: ${details.path || sha} — ${details.edits_applied ?? "?"} edit(s) rebased into ` +
          `${details.docx ?? "the source .docx"} as Word tracked changes; the .md view was ` +
          "refreshed and shows them as CriticMarkup (ledger: pack_executed)",
      );
    } else if (record.op === "pack_rejected") {
      lines.push(
        `PACK REJECTED (${details.reason ?? "?"}): ${details.detail ?? ""} — ` +
          `the .docx and its .md view are unchanged (${details.path ?? "?"})`,
      );
    } else if (record.op === "fetch_executed") {
      lines.push(
        `FETCHED: ${sha} body downloaded to ${details.path ?? "?"} — ` +
          "read it with `mail read` (ledger: fetch_executed)",
      );
    } else if (record.op === "fetch_noop") {
      lines.push(
        `FETCH NOOP: ${sha} already has its body on disk at ${details.path ?? "?"}`,
      );
    } else if (record.op === "fetch_rejected") {
      lines.push(
        `FETCH REJECTED (${details.reason ?? "?"}): ${details.detail ?? ""}`,
      );
    } else if (record.op === "login_started") {
      const url = (details as { url?: string }).url;
      lines.push(
        `LOGIN STARTED: ${(details as { account?: string }).account ?? "?"} — ` +
          "a sign-in page is opening in the browser" +
          (url ? ` (if it didn't, open: ${url})` : "") +
          "; check `mail status` for the auth state (ledger: login_started)",
      );
    } else if (record.op === "login_rejected") {
      lines.push(
        `LOGIN REJECTED: ${(details as { address?: string }).address ?? "?"} — ` +
          `${(details as { reason?: string }).reason ?? "unknown reason"} ` +
          "(nothing was connected)",
      );
    }
  }
  return lines;
}

/** Non-reentrant async mutex; tryAcquire() for pulls, acquire() for pushes. */
class CycleLock {
  private queue: Array<() => void> = [];
  private held = false;

  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }

  async acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next(); // hand the lock over without dropping it
    } else {
      this.held = false;
    }
  }
}

/**
 * Provider backends for the folder-change primitive (archive/unarchive now,
 * `mail move` in phase 2). Injected so tests can fake them; the defaults
 * call the real Gmail/Graph adapters with the archive/unarchive presets.
 */
export interface FolderOps {
  gmail: (
    acct: AccountConfig,
    change: { op: "archive" | "unarchive"; messageId: string },
  ) => Promise<"applied" | "noop">;
  microsoft: (
    acct: AccountConfig,
    change: { op: "archive" | "unarchive"; messageId: string },
  ) => Promise<"applied" | "noop">;
}

/**
 * Provider backends for on-demand body download (`mail fetch`). Injected so
 * tests can fake them; defaults use the real Gmail/Graph adapters.
 */
export interface BodyFetchers {
  gmail: (
    acct: AccountConfig,
    wants: Array<{ sha: string; providerMsgId: string }>,
  ) => Promise<Map<string, Buffer>>;
  microsoft: (acct: AccountConfig, graphId: string) => Promise<Buffer>;
}

export interface BrokerOptions {
  mode?: "daemon" | "boundary";
  /** test seams */
  gmailSync?: typeof gmail.sync;
  graphSync?: typeof msgraph.sync;
  deliverers?: intents.Deliverers;
  draftUploaders?: intents.DraftUploaders;
  draftDeleters?: intents.DraftDeleters;
  detectProvider?: typeof detectProvider;
  folderOps?: FolderOps;
  bodyFetchers?: BodyFetchers;
}

export class Broker {
  readonly mode: "daemon" | "boundary";
  readonly layout: Layout;
  readonly ledger: Ledger;
  readonly index: Index;
  readonly loginManager = new msgraph.LoginManager();
  readonly gmailSetup = new GmailSetupFlow();
  readonly settingsPage = new SettingsPageFlow();
  private readonly lock = new CycleLock();
  private lastNetworkSync: string | null = null;
  private lastPullMonotonic: number | null = null;
  private readonly gmailConn = new gmail.ConnectionCache();
  private readonly hashCache: snapshot.HashCache;
  private readonly opts: BrokerOptions;

  constructor(home?: string, opts: BrokerOptions = {}) {
    this.mode = opts.mode ?? "daemon";
    this.opts = opts;
    this.layout = new Layout(home);
    this.layout.ensureRoom();
    this.layout.ensureBroker();
    ensureDefaultConfig(this.layout.configPath);
    this.ledger = new Ledger(this.layout.ledgerPath);
    this.index = new Index(this.layout.dbPath, {
      legacyJson: this.layout.indexPath,
    });
    this.hashCache = snapshot.loadHashCache(this.layout);
  }

  // ---- boundary API ----------------------------------------------

  /**
   * Start-of-tool-call hook: sync the outside world into the room.
   * Throttled to one network sync per pull_interval_seconds. If another
   * cycle holds the lock the pull is skipped rather than queued. Never
   * throws. Returns true if a cycle actually ran.
   */
  async pull(opts: { force?: boolean } = {}): Promise<boolean> {
    if (!this.lock.tryAcquire()) return false;
    try {
      const now = performance.now(); // monotonic ms
      const intervalMs =
        loadConfig(this.layout.configPath).pull_interval_seconds * 1000;
      const due =
        opts.force ||
        this.lastPullMonotonic === null ||
        now - this.lastPullMonotonic >= intervalMs;
      if (!due) return false;
      await this.runCycleLocked(true);
      this.lastPullMonotonic = now;
      return true;
    } catch (err) {
      log.error(`boundary pull failed; tool call continues: ${err}`);
      return false;
    } finally {
      this.lock.release();
    }
  }

  /**
   * End-of-tool-call hook: execute what the call queued. Local-only cycle;
   * blocks on the lock (a queued send must not be skipped just because a
   * pull is finishing). Never throws.
   */
  async push(): Promise<boolean> {
    await this.lock.acquire();
    try {
      await this.runCycleLocked(false);
      return true;
    } catch (err) {
      log.error(`boundary push failed; tool call continues: ${err}`);
      return false;
    } finally {
      this.lock.release();
    }
  }

  /**
   * push() that also reports what happened to queued sends, so the tool
   * result carries the actual outcome (`mail send` prints its NOTE before
   * the push runs). Never throws.
   */
  async pushReport(): Promise<string[]> {
    return (await this.pushReportDetailed()).lines;
  }

  /**
   * pushReport() that also returns the raw ledger slice of the cycle, for
   * callers (the activity app) that need structured outcomes rather than
   * the human sentences. Never throws.
   */
  async pushReportDetailed(): Promise<{
    lines: string[];
    records: LedgerRecord[];
  }> {
    await this.lock.acquire();
    try {
      const offset = this.ledger.tailOffset();
      try {
        await this.runCycleLocked(false);
      } catch (err) {
        log.error(`boundary push failed; tool call continues: ${err}`);
        return {
          lines: [
            "PUSH FAILED: queued sends were NOT processed this call; " +
              "they remain queued (see the server log)",
          ],
          records: [],
        };
      }
      const records = this.ledger.readSince(offset);
      return { lines: sendOutcomeLines(records), records };
    } finally {
      this.lock.release();
    }
  }

  // ---- cycle ------------------------------------------------------

  /** One broker cycle (daemon mode and tests drive this directly). */
  async runCycle(opts: { syncNetwork?: boolean } = {}): Promise<void> {
    await this.lock.acquire();
    try {
      await this.runCycleLocked(opts.syncNetwork ?? true);
    } finally {
      this.lock.release();
    }
  }

  private async runCycleLocked(syncNetwork: boolean): Promise<void> {
    // progress.step() feeds the activity app's live view during boundary
    // calls; it is a no-op when no tool call is being tracked (daemon mode)
    progress.step("checking requests");
    let cfg = loadConfig(this.layout.configPath);
    if (await this.processAccountRequests(cfg)) {
      cfg = loadConfig(this.layout.configPath); // pick the new account up this cycle
    }
    // Accounts declared only in the extension settings reach us as env vars
    // and used to vanish when those settings were cleared or the extension
    // reinstalled (the user's first-ever account was typically lost this
    // way, silently ending its sync). Persist every account the merged
    // config knows into the durable file on first sight; appendAccountToFile
    // is a no-op when the address is already listed.
    for (const acct of cfg.accounts) {
      if (appendAccountToFile(this.layout.configPath, acct)) {
        log.info(
          `persisted ${acct.provider} account ${acct.address} into config.json`,
        );
      }
    }
    for (const acct of cfg.accounts) {
      try {
        this.layout.ensureAccount(acct.address);
      } catch (err) {
        // a malformed address must cost one account, not the whole cycle
        log.error(`skipping account ${JSON.stringify(acct.address)}: ${err}`);
      }
    }

    const explained = new Set<string>();
    const previous = snapshot.loadPrevious(this.layout);

    this.observeDrafts(previous, explained);
    this.foldTags();
    await this.processLoginRequests(cfg);
    this.processPendingRemovals(explained);
    await this.processSettingsRequests();
    // only authenticated accounts count as "own" recipients: the agent can
    // register addresses, so configuration alone must not widen the allowlist
    const auth = await this.authSummary(cfg);
    const authenticatedOwn = new Set(
      Object.entries(auth)
        .filter(([, state]) => state === "ok")
        .map(([address]) => address),
    );
    progress.step("executing queued sends");
    await intents.processOutboxes(
      this.layout,
      this.index,
      this.ledger,
      cfg,
      explained,
      this.opts.deliverers ?? this.defaultDeliverers(cfg),
      authenticatedOwn,
    );
    progress.step("filing drafts");
    await intents.processDraftBox(
      this.layout,
      this.ledger,
      cfg,
      explained,
      this.opts.draftUploaders ?? this.defaultDraftUploaders(cfg),
      this.opts.draftDeleters ?? this.defaultDraftDeleters(cfg),
    );
    progress.step("applying folder changes");
    await this.processFolderRequests(cfg, explained);
    progress.step("packing documents");
    await this.processPackRequests();
    progress.step("downloading message bodies");
    const justFetched = await this.processFetchRequests(cfg, explained);
    this.enforceLru(cfg, explained, justFetched);
    if (syncNetwork) {
      progress.step("checking sign-ins");
      await this.lazyLogins(cfg);
      // one history budget per cycle, shared by both providers: whichever
      // backfill runs first may consume it, and a caught-up account costs
      // nothing — a tool call is never stretched by more than the budget
      const historyDeadline = Date.now() + BACKFILL_BUDGET_MS;
      progress.step("syncing Gmail");
      try {
        await (this.opts.gmailSync ?? gmail.sync)(
          this.layout,
          this.index,
          this.ledger,
          cfg,
          explained,
          { connCache: this.gmailConn, historyDeadline },
        );
      } catch (err) {
        log.error(`gmail sync failed: ${err}`);
      }
      progress.step("syncing Microsoft");
      try {
        await (this.opts.graphSync ?? msgraph.sync)(
          this.layout,
          this.index,
          this.ledger,
          cfg,
          explained,
          { historyDeadline },
        );
      } catch (err) {
        log.error(`microsoft sync failed: ${err}`);
      }
      this.lastNetworkSync = new Date().toISOString();
    }

    this.reconcileLocalFolders(explained);

    progress.step("auditing the room");
    const current = snapshot.buildManifest(this.layout, this.hashCache);
    snapshot.diffAudit(this.layout, this.ledger, previous, current, explained);
    snapshot.save(this.layout, current, previous);
    snapshot.saveHashCache(this.layout, this.hashCache);
    this.index.flush();
    // status is written into the room AFTER the manifest is saved, so the
    // status file (at room root, outside accounts/) never affects the audit
    snapshot.writeStatus(this.layout, cfg, {
      pendingIntents: snapshot.countPendingIntents(this.layout),
      networkSynced: syncNetwork,
      lastNetworkSync: this.lastNetworkSync,
      mode: this.mode,
      auth: await this.authSummary(cfg),
      ownAddresses: [...authenticatedOwn].sort(),
      authUrls: {
        ...this.loginManager.pendingUrls(),
        ...this.gmailSetup.pendingUrls(),
      },
    });
  }

  private defaultDeliverers(cfg: Config): intents.Deliverers {
    return {
      gmail: async (acct, mime, recipients) => {
        await gmail.sendMime(this.layout, cfg, acct, mime, recipients);
        return messageIdOf(mime);
      },
      microsoft: async (acct, mime) => {
        await msgraph.sendMime(this.layout, acct, mime);
        return messageIdOf(mime);
      },
    };
  }

  private defaultDraftUploaders(cfg: Config): intents.DraftUploaders {
    return {
      gmail: async (acct, mime) => {
        await gmail.uploadDraft(this.layout, cfg, acct, mime, {
          connCache: this.gmailConn,
        });
        return messageIdOf(mime);
      },
      microsoft: async (acct, mime) => {
        const res = await msgraph.uploadDraft(this.layout, acct, mime);
        return res.internetMessageId ?? messageIdOf(mime);
      },
    };
  }

  private defaultDraftDeleters(cfg: Config): intents.DraftDeleters {
    return {
      gmail: async (acct, messageId) =>
        gmail.deleteDraft(this.layout, cfg, acct, messageId, {
          connCache: this.gmailConn,
        }),
      microsoft: async (acct, messageId) =>
        msgraph.deleteDraft(this.layout, acct, messageId),
    };
  }

  /**
   * Local-only auth readiness per account address, published to the room so
   * the agent can tell the user exactly what is missing.
   */
  private async authSummary(cfg: Config): Promise<Record<string, string>> {
    const summary: Record<string, string> = {};
    for (const acct of cfg.accounts) {
      if (acct.provider === "gmail") {
        const password = await gmailAppPassword(this.layout, cfg, acct.address);
        if (!password) summary[acct.address] = "no_app_password";
        else if (!/^[\x00-\x7f]*$/.test(password))
          summary[acct.address] = "bad_app_password";
        else summary[acct.address] = "ok";
      } else {
        summary[acct.address] = await msgraph.authState(this.layout, acct);
      }
    }
    return summary;
  }

  /**
   * First-tool-call lazy login: any account that needs a human gets its
   * loopback flow started and the browser opened — automatically only once
   * per process run; after that the URL stays in `mail status`. Microsoft
   * opens the OAuth sign-in; Gmail opens the app-password setup wizard.
   */
  private async lazyLogins(cfg: Config): Promise<void> {
    for (const acct of cfg.accounts) {
      const address = acct.address.toLowerCase();
      if (acct.provider === "microsoft" && acct.client_id) {
        if (this.loginManager.autoAttempted.has(address)) continue;
        if ((await msgraph.authState(this.layout, acct)) !== "needs_login")
          continue;
        this.loginManager.autoAttempted.add(address);
        try {
          await this.loginManager.ensureFlow(this.layout, acct, {
            autoOpen: true,
          });
          this.ledger.append("login_started", {
            account: address,
            trigger: "lazy",
          });
        } catch (err) {
          log.error(
            `microsoft: could not start sign-in flow for ${address}: ${err}`,
          );
        }
      } else if (acct.provider === "gmail") {
        if (this.gmailSetup.autoAttempted.has(address)) continue;
        if (await gmailAppPassword(this.layout, cfg, acct.address)) continue;
        this.gmailSetup.autoAttempted.add(address);
        try {
          await this.startGmailSetup(address);
          this.ledger.append("login_started", {
            account: address,
            provider: "gmail",
            trigger: "lazy",
          });
        } catch (err) {
          log.error(
            `gmail: could not start the setup wizard for ${address}: ${err}`,
          );
        }
      }
    }
  }

  private async startGmailSetup(address: string): Promise<string> {
    return this.gmailSetup.ensureFlow(address, {
      autoOpen: true,
      onStored: async (addr, password) =>
        await storeGmailAppPassword(this.layout, addr, password),
    });
  }

  /** Consume a room-root request file: parse one object or JSONL lines. */
  private readRequests(name: string): Array<Record<string, unknown>> {
    const file = path.join(this.layout.room, name);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      return [];
    }
    fs.rmSync(file, { force: true });
    try {
      const one = JSON.parse(text);
      return Array.isArray(one) ? one : [one];
    } catch {
      /* JSONL */
    }
    const requests: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        requests.push(JSON.parse(line));
      } catch {
        log.warn(`skipping unparseable request line in ${name}`);
      }
    }
    return requests;
  }

  /**
   * `mail account add <provider> <address>` appends to
   * room/.account-request.json (JSONL): persists accounts to broker/config.json.
   */
  private async processAccountRequests(cfg: Config): Promise<boolean> {
    let changed = false;
    for (const request of this.readRequests(ACCOUNT_REQUEST_FILE)) {
      const provider = String(request?.provider ?? "").toLowerCase();
      const address = String(request?.address ?? "")
        .trim()
        .toLowerCase();
      if (
        (provider !== "gmail" && provider !== "microsoft") ||
        !isValidAccountAddress(address)
      ) {
        this.ledger.append(
          "account_add_rejected",
          { provider, address, reason: "invalid provider or address" },
          { actor: "agent" },
        );
        continue;
      }
      const account: AccountConfig = { provider, address };
      let clientIdMissing = false;
      if (provider === "microsoft") {
        const clientId = defaultMsClientId(cfg);
        if (clientId) account.client_id = clientId;
        else clientIdMissing = true;
      }
      const added = persistAccount(this.layout.configPath, account);
      changed = changed || added;
      try {
        this.layout.ensureAccount(address);
      } catch (err) {
        log.error(`could not create account dirs for ${address}: ${err}`);
        continue;
      }
      this.ledger.append(
        added ? "account_added" : "account_add_noop",
        clientIdMissing
          ? {
              provider,
              address,
              note: "no Microsoft client_id yet; sign-in starts once it is set",
            }
          : { provider, address },
        { actor: "agent" },
      );
      if (provider === "microsoft" && account.client_id) {
        try {
          await this.loginManager.ensureFlow(this.layout, account, {
            autoOpen: true,
          });
          this.ledger.append(
            "login_started",
            { account: address, trigger: "mail account add" },
            { actor: "agent" },
          );
        } catch (err) {
          log.error(
            `microsoft: could not start sign-in flow for ${address}: ${err}`,
          );
        }
      }
    }
    return changed;
  }

  /**
   * `mail login [address] [--provider ...] [--client-id ...]` writes
   * room/.login-request.json; honor it here.
   */
  private async processLoginRequests(cfg: Config): Promise<void> {
    const file = path.join(this.layout.room, LOGIN_REQUEST_FILE);
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return;
    }
    fs.rmSync(file, { force: true });
    const wanted = String(request.address ?? "").toLowerCase();

    if (!wanted) {
      // no address: reopen the sign-in for every Microsoft account
      const targets = cfg.accounts.filter(
        (a) => a.provider === "microsoft" && a.client_id,
      );
      if (!targets.length) {
        log.warn("login request without address matches no microsoft account");
        return;
      }
      for (const acct of targets) {
        await this.startRequestedLogin(acct);
      }
      return;
    }

    const existing = findAccount(cfg, wanted);
    if (existing) {
      const requestedProvider = String(request.provider ?? "").toLowerCase();
      if (requestedProvider && requestedProvider !== existing.provider) {
        this.ledger.append(
          "login_rejected",
          {
            address: wanted,
            reason: `registered as ${existing.provider}; ${requestedProvider} sign-in does not apply`,
          },
          { actor: "agent" },
        );
        log.warn(
          `login request for ${wanted}: account is ${existing.provider}, not ${requestedProvider}`,
        );
        return;
      }
      await this.startRequestedLogin(existing);
      return;
    }

    const acct = await this.registerAccount(cfg, wanted, request);
    if (!acct) {
      this.ledger.append(
        "login_rejected",
        {
          address: wanted,
          reason:
            "could not register the account — provider not given/detectable, " +
            "or a first Microsoft account is missing its client_id " +
            "(set the Microsoft app ID in the extension settings)",
        },
        { actor: "agent" },
      );
      return;
    }
    await this.startRequestedLogin(acct);
  }

  /** Bring a `mail login`-named address into the config, or explain why not. */
  private async registerAccount(
    cfg: Config,
    address: string,
    request: Record<string, unknown>,
  ): Promise<AccountConfig | null> {
    const requested = String(request.provider ?? "").toLowerCase();
    const provider =
      requested === "gmail" || requested === "microsoft"
        ? (requested as AccountConfig["provider"])
        : await (this.opts.detectProvider ?? detectProvider)(address);
    if (!provider) {
      log.warn(
        `login request for ${address}: provider not given and not detectable from ` +
          "MX records — ask the user whether the mailbox is on Google or Microsoft " +
          "and rerun `mail login` with --provider gmail|microsoft",
      );
      return null;
    }
    let clientId: string | undefined;
    if (provider === "microsoft") {
      clientId =
        String(request.client_id ?? "").trim() || defaultMsClientId(cfg);
      if (!clientId) {
        log.warn(
          `login request for ${address}: a first microsoft account needs a client_id ` +
            "(Azure app registration) — rerun `mail login` with --client-id",
        );
        return null;
      }
    }
    const acct: AccountConfig = { provider, address, client_id: clientId };
    appendAccountToFile(this.layout.configPath, acct);
    cfg.accounts.push(acct);
    this.layout.ensureAccount(address);
    log.info(
      `registered new ${provider} account ${address} from a login request`,
    );
    return acct;
  }

  private async startRequestedLogin(acct: AccountConfig): Promise<void> {
    try {
      let url: string | null;
      if (acct.provider === "gmail") {
        url = await this.startGmailSetup(acct.address);
      } else {
        if (!acct.client_id) {
          this.ledger.append(
            "login_rejected",
            {
              address: acct.address,
              reason:
                "microsoft account has no client_id — set the Microsoft app " +
                "(client) ID in the extension settings, then run `mail login` again",
            },
            { actor: "agent" },
          );
          log.warn(
            `microsoft account ${acct.address} has no client_id; cannot sign in`,
          );
          return;
        }
        url = await this.loginManager.ensureFlow(this.layout, acct, {
          autoOpen: true,
        });
      }
      this.ledger.append(
        "login_started",
        {
          account: acct.address,
          provider: acct.provider,
          trigger: "mail login",
          url,
        },
        { actor: "agent" },
      );
    } catch (err) {
      this.ledger.append(
        "login_rejected",
        {
          address: acct.address,
          reason: `could not start the sign-in flow: ${err}`,
        },
        { actor: "agent" },
      );
      log.error(
        `${acct.provider}: could not start the sign-in flow for ${acct.address}: ${err}`,
      );
    }
  }

  /**
   * `mail archive` / `mail unarchive` append JSONL requests to
   * room/.folder-request.jsonl; execute them here. Each request is handled
   * independently (a bad one costs itself, not the batch), honours dry_run,
   * is idempotent provider-side, and never deletes anything. On success (or
   * simulation) the local .eml moves between INBOX/ and Archive/ and the
   * index row is re-homed so `mail index` reflects the change.
   */
  private async processFolderRequests(
    cfg: Config,
    explained: Set<string>,
  ): Promise<void> {
    for (const request of this.readRequests(FOLDER_REQUEST_FILE)) {
      const op = String(request?.op ?? "");
      const account = String(request?.account ?? "").toLowerCase();
      const relPath = String(request?.path ?? "");
      const messageId = String(request?.message_id ?? "");
      const sha = String(request?.sha ?? "");
      const reject = (reason: string, detail: string): void => {
        this.ledger.append(
          "folder_change_rejected",
          { op, account, path: relPath, reason, detail },
          { sha: sha || null },
        );
      };
      if (op !== "archive" && op !== "unarchive") {
        reject("invalid_op", `unknown folder operation ${JSON.stringify(op)}`);
        continue;
      }
      const acct = findAccount(cfg, account);
      if (!acct) {
        reject(
          "unknown_account",
          `${account || "(none)"} matches no configured account`,
        );
        continue;
      }
      if (!messageId) {
        reject(
          "missing_message_id",
          "request carries no Message-ID; cannot identify the message provider-side",
        );
        continue;
      }
      if (cfg.dry_run) {
        this.ledger.append(
          "folder_change_simulated",
          {
            op,
            account,
            path: relPath,
            note: "dry_run = true in config; no provider call was made",
          },
          { sha: sha || null },
        );
        // Deliberately NO applyLocalFolderChange here. A simulated change must
        // leave the room byte-identical to the mailbox it mirrors.
        //
        // This used to move the .eml and re-home the index anyway, "just a
        // preview". But mail.py's no-op guards read exactly that state and do
        // not consult dry_run, so the preview made the room claim a message was
        // archived while the provider still had it in the inbox — and every
        // later REAL archive of it short-circuited to "already archived
        // (no-op)", exit 0, nothing queued, provider never called. Turning dry
        // run off did not recover, because the guard fires on local state
        // alone. Nothing reconciles that drift, so it was permanent and silent.
        continue;
      }
      try {
        const ops = this.opts.folderOps ?? this.defaultFolderOps(cfg);
        const result = await ops[acct.provider](acct, { op, messageId });
        this.ledger.append(
          "folder_change_executed",
          { op, account, path: relPath, result },
          { sha: sha || null },
        );
        this.applyLocalFolderChange(op, account, relPath, sha, explained);
      } catch (err) {
        if (err instanceof intents.Rejection) reject(err.reason, err.detail);
        else reject("error", String(err));
      }
    }
  }

  /**
   * `mail pack <view.docx.md>` appends JSONL requests to
   * room/.pack-request.jsonl; execute them here. Each request rebases the
   * agent's edits of the Markdown view into the sibling .docx as Word
   * tracked changes (authored "AI Agent"), then refreshes the view from the
   * packed binary so it shows the changes as CriticMarkup. All-or-nothing
   * per document: a rejected batch leaves both files untouched. Local-only
   * (no provider call), so dry_run does not apply.
   */
  private async processPackRequests(): Promise<void> {
    for (const request of this.readRequests(PACK_REQUEST_FILE)) {
      const relPath = String(request?.path ?? "").replace(/\\/g, "/");
      const reject = (
        reason: string,
        detail: string,
        sha: string | null = null,
      ): void => {
        this.ledger.append(
          "pack_rejected",
          { path: relPath, reason, detail },
          { sha },
        );
      };
      if (
        !relPath.startsWith("attachments/") ||
        relPath.split("/").some((seg) => seg === ".." || seg === "") ||
        !relPath.toLowerCase().endsWith(".docx.md")
      ) {
        reject(
          "invalid_path",
          "pack accepts only Markdown views of .docx attachments " +
            "(attachments/<sha>/<name>.docx.md); PDF views are read-only",
        );
        continue;
      }
      let mdPath: string;
      try {
        mdPath = this.layout.jail(relPath);
      } catch (err) {
        reject("invalid_path", String(err));
        continue;
      }
      const docxPath = mdPath.slice(0, -3);
      if (!fs.existsSync(mdPath) || !fs.existsSync(docxPath)) {
        reject(
          "not_found",
          `${relPath} and its source ${relPath.slice(0, -3)} must both exist`,
        );
        continue;
      }
      try {
        const docxBuffer = fs.readFileSync(docxPath);
        const modified = fs.readFileSync(mdPath, "utf-8");
        const result = await packDocx(docxBuffer, modified);
        if (!result.ok) {
          reject(result.reason, result.detail, sha12(docxBuffer));
          continue;
        }
        fs.writeFileSync(docxPath, result.buffer);
        fs.writeFileSync(mdPath, asViewFile(result.view));
        this.ledger.append(
          "pack_executed",
          {
            path: relPath,
            docx: relPath.slice(0, -3),
            edits_applied: result.editsApplied,
          },
          { sha: sha12(result.buffer) },
        );
      } catch (err) {
        reject("error", String(err));
      }
    }
  }

  /**
   * `mail fetch <id>` appends JSONL requests to room/.fetch-request.jsonl;
   * download the bodies here. Inbound-only (never gated by dry_run), one
   * IMAP session per Gmail account per cycle, each request independent.
   * Bodies land in accounts/<addr>/mail/.Cache/cur/ and the index row is
   * upgraded in place; the outcome rides in the tool result.
   */
  private async processFetchRequests(
    cfg: Config,
    explained: Set<string>,
  ): Promise<Set<string>> {
    const stored = new Set<string>();
    const requests = this.readRequests(FETCH_REQUEST_FILE);
    if (!requests.length) return stored;
    const fetchers = this.opts.bodyFetchers ?? this.defaultBodyFetchers(cfg);
    const reject = (sha: string, reason: string, detail: string): void => {
      this.ledger.append(
        "fetch_rejected",
        { sha, reason, detail },
        { actor: "agent", sha: sha || null },
      );
    };

    // resolve + validate, dedup repeated ids, group gmail wants per account
    const gmailWants = new Map<
      string,
      Array<{ sha: string; providerMsgId: string }>
    >();
    const graphWants: Array<{
      acct: AccountConfig;
      sha: string;
      providerMsgId: string;
    }> = [];
    const seen = new Set<string>();
    for (const request of requests) {
      const sha = String(request?.sha ?? request?.id ?? "").trim();
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      const row = this.index.getBySha(sha);
      if (!row) {
        reject(sha, "unknown_id", `no message with id ${JSON.stringify(sha)}`);
        continue;
      }
      if (row.path) {
        this.ledger.append(
          "fetch_noop",
          { path: row.path },
          { actor: "agent", sha },
        );
        continue;
      }
      const acct = findAccount(cfg, row.account);
      if (!acct) {
        reject(
          sha,
          "unknown_account",
          `${row.account} matches no configured account`,
        );
        continue;
      }
      if (!row.gmailId) {
        reject(
          sha,
          "not_fetchable",
          "the row carries no provider message id; it predates on-demand fetch",
        );
        continue;
      }
      if (acct.provider === "gmail") {
        let wants = gmailWants.get(row.account);
        if (!wants) gmailWants.set(row.account, (wants = []));
        wants.push({ sha, providerMsgId: row.gmailId });
      } else {
        graphWants.push({ acct, sha, providerMsgId: row.gmailId });
      }
    }

    for (const [address, wants] of gmailWants) {
      const acct = findAccount(cfg, address);
      if (!acct) continue; // validated above
      let got: Map<string, Buffer>;
      try {
        got = await fetchers.gmail(acct, wants);
      } catch (err) {
        const [reason, detail] =
          err instanceof intents.Rejection
            ? [err.reason, err.detail]
            : ["error", String(err)];
        for (const w of wants) reject(w.sha, reason, detail);
        continue;
      }
      for (const w of wants) {
        const raw = got.get(w.sha);
        if (!raw) {
          reject(
            w.sha,
            "not_found_on_server",
            `provider id ${w.providerMsgId} matched nothing in the mailbox`,
          );
          continue;
        }
        if (await this.storeFetched(w.sha, raw, explained)) stored.add(w.sha);
      }
    }
    for (const want of graphWants) {
      try {
        const raw = await fetchers.microsoft(want.acct, want.providerMsgId);
        if (await this.storeFetched(want.sha, raw, explained)) {
          stored.add(want.sha);
        }
      } catch (err) {
        if (err instanceof intents.Rejection) {
          reject(want.sha, err.reason, err.detail);
        } else {
          reject(want.sha, "error", String(err));
        }
      }
    }
    return stored;
  }

  private async storeFetched(
    sha: string,
    raw: Buffer,
    explained: Set<string>,
  ): Promise<boolean> {
    const row = this.index.getBySha(sha);
    if (!row) return false;
    try {
      await storeFetchedBody(this.layout, this.index, this.ledger, {
        row,
        raw,
        explained,
      });
      return true;
    } catch (err) {
      this.ledger.append(
        "fetch_rejected",
        { sha, reason: "store_failed", detail: String(err) },
        { actor: "agent", sha },
      );
      return false;
    }
  }

  /**
   * Keep the on-demand body cache within its quota: least-recently-used
   * inbound bodies drop back to metadata-only rows (their .eml/.meta are
   * deleted; re-running `mail fetch` restores them). Pinned bodies and
   * folder-synced mail are untouched.
   */
  private enforceLru(
    cfg: Config,
    explained: Set<string>,
    justFetched: Set<string> = new Set(),
  ): void {
    const capBytes = Math.max(0, Math.round(cfg.body_cache_mb * 1024 * 1024));
    let bytes = this.index.inboundCacheBytes();
    if (bytes <= capBytes) return;
    for (const victim of this.index.lruVictims()) {
      if (bytes <= capBytes) break;
      // a body downloaded THIS cycle survives it: the agent asked for it
      // and gets at least one command's use before quota pressure applies
      if (justFetched.has(victim.sha)) continue;
      const full = path.join(this.layout.room, victim.path);
      try {
        for (const target of [full, full + ".meta"]) {
          if (fs.existsSync(target)) {
            explained.add(this.layout.rel(target));
            fs.rmSync(target, { force: true });
          }
        }
      } catch (err) {
        log.warn(`lru: could not delete ${victim.path}: ${err}`);
        continue; // keep the row consistent with the surviving file
      }
      this.index.evictBody(victim.sha);
      this.ledger.append(
        "body_evicted",
        { account: victim.account, path: victim.path, bytes: victim.bodySize },
        { sha: victim.sha },
      );
      bytes -= victim.bodySize;
    }
  }

  private defaultBodyFetchers(cfg: Config): BodyFetchers {
    return {
      gmail: (acct, wants) =>
        gmail.fetchBodies(this.layout, this.index, cfg, acct, wants, {
          connCache: this.gmailConn,
        }),
      microsoft: (acct, graphId) =>
        msgraph.fetchBody(this.layout, acct, graphId),
    };
  }

  /** Archive/unarchive presets over the provider-abstracted primitive. */
  private defaultFolderOps(cfg: Config): FolderOps {
    return {
      gmail: (acct, change) =>
        gmail.applyFolderChange(
          this.layout,
          cfg,
          acct,
          change.op === "archive"
            ? {
                messageId: change.messageId,
                removeLabels: ["INBOX"],
                addLabels: [],
              }
            : {
                messageId: change.messageId,
                removeLabels: [],
                addLabels: ["INBOX"],
              },
          { connCache: this.gmailConn },
        ),
      microsoft: (acct, change) =>
        msgraph.moveMessage(this.layout, acct, {
          internetMessageId: change.messageId,
          target: change.op === "archive" ? "archive" : "inbox",
        }),
    };
  }

  /** Mirror a folder change into the room: move the .eml + .meta, re-index. */
  private applyLocalFolderChange(
    op: "archive" | "unarchive",
    account: string,
    relPath: string,
    sha: string,
    explained: Set<string>,
  ): void {
    this.moveLocalMessage(
      op === "archive" ? "Archive" : "INBOX",
      account,
      relPath,
      sha,
      explained,
    );
  }

  /**
   * Move a message's local .eml into `destFolder` and re-home its index row.
   *
   * Takes the destination directly rather than an archive/unarchive op, because
   * drift correction has to reach folders those two words cannot name — a
   * message the provider reports in Sent must not be filed under Archive.
   */
  private moveLocalMessage(
    destFolder: string,
    account: string,
    relPath: string,
    sha: string,
    explained: Set<string>,
  ): void {
    if (!relPath) {
      // id-based request for a metadata-only row: no file to move, but the
      // index should reflect the provider-side change
      if (sha) this.index.updateMessageLocation(sha, destFolder, "");
      return;
    }
    const src = path.join(this.layout.room, relPath);
    const name = path.basename(relPath);
    const destDir = path.join(
      this.layout.accounts,
      account,
      "mail",
      destFolder,
      "cur",
    );
    const dest = path.join(destDir, name);
    const destRel = this.layout.rel(dest);
    explained.add(relPath);
    explained.add(destRel);
    try {
      if (fs.existsSync(src) && src !== dest) {
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(src, dest);
        if (fs.existsSync(src + ".meta")) {
          explained.add(relPath + ".meta");
          explained.add(destRel + ".meta");
          fs.renameSync(src + ".meta", dest + ".meta");
        }
      }
    } catch (err) {
      log.warn(
        `local move of ${relPath} to ${destFolder} failed ` +
          `(any provider change stands): ${err}`,
      );
    }
    if (sha) this.index.updateMessageLocation(sha, destFolder, destRel);
  }

  /**
   * `mail settings` writes room/.settings-request.json; open the local
   * settings page (nonce-protected, 127.0.0.1). The agent may open it; only
   * the human clicks. Saves go through config.saveSettingsPage() (page-owned
   * values win over the extension pane's env injection), account removal
   * deletes the credential + config entry immediately and queues local-mail
   * deletion for the next cycle so the audit can be told about it.
   */
  private async processSettingsRequests(): Promise<void> {
    if (!this.readRequests(SETTINGS_REQUEST_FILE).length) return;
    try {
      const url = await this.settingsPage.ensureFlow({
        autoOpen: true,
        getState: async () => {
          const fresh = loadConfig(this.layout.configPath);
          const auth = await this.authSummary(fresh);
          return {
            accounts: fresh.accounts.map((a) => ({
              address: a.address,
              provider: a.provider,
              auth: auth[a.address] ?? "unknown",
            })),
            dry_run: fresh.dry_run,
            dry_run_source: dryRunSource(this.layout.configPath),
            allowed_recipient_domains: fresh.policy.allowed_recipient_domains,
          };
        },
        onSaveSafety: async (values) => {
          saveSettingsPage(this.layout.configPath, values);
          this.ledger.append("settings_changed", {
            dry_run: values.dry_run,
            allowed_recipient_domains: values.allowed_recipient_domains,
            surface: "settings_page",
          });
          log.info(
            `settings page: dry_run=${values.dry_run}, domains=[${values.allowed_recipient_domains.join(", ")}]`,
          );
          // same staleness: `mail archive` reads dry_run from the status file to
          // tell the user whether the change will be simulated, so a stale file
          // makes it announce the OPPOSITE of what the broker will do
          await this.publishStatus();
        },
        onRemoveAccount: async (address, deleteLocal) => {
          const removed = removeAccountFromFile(
            this.layout.configPath,
            address,
          );
          await deleteGmailAppPassword(this.layout, address);
          // Sync bookkeeping is dead either way — the account no longer syncs.
          // Messages are NOT touched here: "keep the local copy" means the user
          // can still read that mail, so those rows only go with the files (see
          // processPendingRemovals).
          this.index.forgetAccountSyncState(address);
          this.ledger.append("account_removed", {
            address,
            config_entry_removed: removed,
            local_mail: deleteLocal ? "queued_for_deletion" : "kept",
            surface: "settings_page",
          });
          if (deleteLocal) this.queuePendingRemoval(address);
          log.info(
            `settings page: removed ${address} (local mail ${deleteLocal ? "queued for deletion" : "kept"})`,
          );
          // so the very next command sees the removal, whatever the pull
          // throttle is doing
          await this.publishStatus();
        },
      });
      this.ledger.append("settings_opened", { url }, { actor: "agent" });
    } catch (err) {
      log.error(`could not open the settings page: ${err}`);
    }
  }

  /**
   * Move .eml files whose row was re-homed by Index.reconcileFolder, so the
   * room's filesystem agrees with the index and with the mailbox.
   *
   * This is the second half of drift correction: sync knows the provider's
   * folder but not the room's file layout, so it updates the row and leaves the
   * file to this step. Runs BEFORE the audit, so every move is explained and
   * never shows up as an unexplained state_diff.
   *
   * Nothing here talks to a provider, so it is safe under dry_run: it is not a
   * change to the mailbox, it is the room catching up with one that already
   * happened outside Message Operator.
   */
  private reconcileLocalFolders(explained: Set<string>): void {
    let corrected = 0;
    for (const row of this.index.rowsWithMisplacedFiles()) {
      const before = row.path;
      try {
        this.moveLocalMessage(
          row.folder,
          row.account,
          row.path,
          row.sha,
          explained,
        );
        this.ledger.append(
          "folder_drift_corrected",
          {
            account: row.account,
            from: before,
            to_folder: row.folder,
            reason: "provider reported a different folder than the room held",
          },
          { sha: row.sha },
        );
        corrected += 1;
      } catch (err) {
        log.warn(`could not re-home ${row.path} to ${row.folder}: ${err}`);
      }
    }
    if (corrected > 0) {
      log.info(
        `re-homed ${corrected} message(s) to match the provider's folders`,
      );
    }
  }

  /**
   * Rewrite room/.broker-status.json from current config, without running a
   * cycle.
   *
   * The room answers "is this mailbox still connected?" from that file, but
   * settings-page edits happen OUTSIDE the cycle, and only a cycle writes it.
   * `pull()` is throttled to one per pull_interval_seconds and returns before
   * running when not due, so after a removal the user's very next command could
   * read a status file that still lists the mailbox as connected — and list a
   * removed mailbox's mail as live. Republishing here removes that window
   * instead of narrowing it.
   *
   * Deliberately narrow: no ledger writes, no pending-removal processing, no
   * audit — so it cannot race or interleave with a cycle holding the lock.
   * writeStatus writes a temp file and renames, so the file is never partial.
   */
  private async publishStatus(): Promise<void> {
    try {
      const cfg = loadConfig(this.layout.configPath);
      snapshot.writeStatus(this.layout, cfg, {
        pendingIntents: snapshot.countPendingIntents(this.layout),
        networkSynced: false, // no network touched; keeps last_network_sync
        lastNetworkSync: this.lastNetworkSync,
        mode: this.mode,
        auth: await this.authSummary(cfg),
        authUrls: {
          ...this.loginManager.pendingUrls(),
          ...this.gmailSetup.pendingUrls(),
        },
      });
    } catch (err) {
      // never let a status refresh break the settings page
      log.warn(`could not republish broker status: ${err}`);
    }
  }

  private queuePendingRemoval(address: string): void {
    const file = path.join(this.layout.brokerDir, PENDING_REMOVALS_FILE);
    let pending: string[] = [];
    try {
      pending = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!Array.isArray(pending)) pending = [];
    } catch {
      pending = [];
    }
    if (!pending.includes(address)) pending.push(address);
    fs.writeFileSync(file, JSON.stringify(pending));
  }

  /**
   * Local-mail deletions requested from the settings page run at cycle
   * start, where every removed path can be explained to the diff audit.
   */
  private processPendingRemovals(explained: Set<string>): void {
    const file = path.join(this.layout.brokerDir, PENDING_REMOVALS_FILE);
    let pending: string[] = [];
    try {
      pending = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!Array.isArray(pending)) pending = [];
    } catch {
      return;
    }
    fs.rmSync(file, { force: true });
    for (const address of pending) {
      const dir = path.join(this.layout.accounts, String(address));
      try {
        if (fs.existsSync(dir)) {
          for (const f of walkFilesUnder(dir))
            explained.add(this.layout.rel(f));
          fs.rmSync(dir, { recursive: true, force: true });
        }
        // The index is the other half of "delete the local mail": `mail index`
        // and `mail search` read the store, so rows left behind here keep
        // listing the removed mailbox, pointing at .eml files just deleted.
        const purged = this.index.deleteAccountMessages(String(address));
        this.ledger.append("account_local_mail_deleted", {
          address,
          index_rows_purged: purged,
        });
        log.info(
          `deleted local mail copy for removed account ${address} ` +
            `(${purged} index row(s) purged)`,
        );
      } catch (err) {
        log.error(`could not delete local mail for ${address}: ${err}`);
      }
    }
  }

  close(): void {
    void this.gmailConn.discard();
    this.loginManager.closeAll();
    this.gmailSetup.closeAll();
    this.settingsPage.closeAll();
    this.index.close();
  }

  // ---- daemon loop -------------------------------------------------

  /** Poll loop. Network sync every `interval`s; local work every `tick`s. */
  async runForever(
    interval: number = POLL_INTERVAL,
    tick: number = TICK,
    stop?: { stopped: boolean },
  ): Promise<void> {
    log.info(
      `broker started; local cycle every ${tick}s, network sync every ${interval}s`,
    );
    let lastSyncAt: number | null = null;
    for (;;) {
      if (stop?.stopped) break;
      const now = Date.now() / 1000;
      const doSync = lastSyncAt === null || now - lastSyncAt >= interval;
      try {
        await this.runCycle({ syncNetwork: doSync });
        if (doSync) lastSyncAt = now;
      } catch (err) {
        log.error(`broker cycle failed: ${err}`);
      }
      await new Promise((r) => setTimeout(r, tick * 1000));
    }
  }

  // ---- observations ----------------------------------------------

  /**
   * Ledger draft_created for new .eml files in Drafts/ and Outbox/new/.
   * Drafts appear when the agent runs `mail reply`/`mail compose`; the
   * broker only observes them on cycle.
   */
  private observeDrafts(
    previous: snapshot.Manifest | null,
    explained: Set<string>,
  ): void {
    const seenBefore = new Set(Object.keys(previous ?? {}));
    for (const address of this.layout.accountAddresses()) {
      const mailRoot = path.join(this.layout.accounts, address, "mail");
      for (const [folder, sub] of [
        ["Drafts", "cur"],
        ["Drafts", "new"],
        ["Outbox", "new"],
      ] as const) {
        const dir = path.join(mailRoot, folder, sub);
        let names: string[];
        try {
          names = fs
            .readdirSync(dir)
            .filter((n) => n.endsWith(".eml"))
            .sort();
        } catch {
          continue;
        }
        for (const name of names) {
          const file = path.join(dir, name);
          const rel = this.layout.rel(file);
          if (seenBefore.has(rel)) continue;
          let sha: string;
          try {
            sha = sha12(fs.readFileSync(file));
          } catch {
            continue;
          }
          this.ledger.append(
            "draft_created",
            { account: address, path: rel },
            { actor: "agent", sha },
          );
          explained.add(rel);
        }
      }
    }
  }

  /**
   * Fold room/.tags.jsonl (written by `mail tag`) into the index. The file
   * is atomically renamed aside first, so tags appended while we process are
   * never lost. A leftover .folding file (crash mid-fold) is finished before
   * claiming a new one.
   */
  private foldTags(): void {
    const tagsFile = this.layout.tagsFile;
    const folding = tagsFile + ".folding";
    if (!fs.existsSync(folding)) {
      let size = 0;
      try {
        size = fs.statSync(tagsFile).size;
      } catch {
        /* ignore */
      }
      if (size > 0) {
        try {
          fs.renameSync(tagsFile, folding);
        } catch {
          /* next cycle */
        }
      }
    }

    const untagFile = this.layout.untagRequestFile;
    const untagFolding = path.join(this.layout.room, ".untag-folding");
    if (!fs.existsSync(untagFolding)) {
      let size = 0;
      try {
        size = fs.statSync(untagFile).size;
      } catch {
        /* ignore */
      }
      if (size > 0) {
        try {
          fs.renameSync(untagFile, untagFolding);
        } catch {
          /* next cycle */
        }
      }
    }

    interface TagEvent {
      seq: number;
      op: "tag" | "untag";
      sha: string;
      tag: string;
      path: unknown;
      ts: string;
    }
    const events: TagEvent[] = [];
    let seq = 0;

    if (fs.existsSync(folding)) {
      const lines = fs.readFileSync(folding, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          log.warn(`skipping unparseable tag line: ${trimmed.slice(0, 100)}`);
          continue;
        }
        const sha = String(entry.sha ?? "");
        const tag = String(entry.tag ?? "");
        if (!sha || !tag) continue;
        const ts = typeof entry.ts === "string" ? entry.ts : "";
        events.push({ seq: ++seq, op: "tag", sha, tag, path: entry.path, ts });
      }
    }

    if (fs.existsSync(untagFolding)) {
      const lines = fs.readFileSync(untagFolding, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          log.warn(`skipping unparseable untag line: ${trimmed.slice(0, 100)}`);
          continue;
        }
        const sha = String(entry.sha ?? "");
        const tag = String(entry.tag ?? "");
        if (!sha || !tag) continue;
        const ts = typeof entry.ts === "string" ? entry.ts : "";
        events.push({
          seq: ++seq,
          op: "untag",
          sha,
          tag,
          path: entry.path,
          ts,
        });
      }
    }

    const at = (ts: string): number => {
      const t = Date.parse(ts);
      return Number.isNaN(t) ? -1 : t;
    };
    events.sort((a, b) => at(a.ts) - at(b.ts) || a.seq - b.seq);

    for (const ev of events) {
      if (ev.op === "tag") {
        if (this.index.addTag(ev.sha, ev.tag, ev.ts || null)) {
          this.ledger.append(
            "tag",
            { tag: ev.tag, path: ev.path },
            { actor: "agent", sha: ev.sha },
          );
        }
      } else {
        if (this.index.removeTag(ev.sha, ev.tag)) {
          this.ledger.append(
            "untag",
            { tag: ev.tag, path: ev.path },
            { actor: "agent", sha: ev.sha },
          );
        }
      }
    }

    if (fs.existsSync(folding)) {
      fs.rmSync(folding, { force: true });
    }
    if (fs.existsSync(untagFolding)) {
      fs.rmSync(untagFolding, { force: true });
    }
  }
}

function walkFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

function messageIdOf(mime: Buffer): string {
  const head = mime.toString("latin1");
  const match = /^message-id:[ \t]*(.+)$/im.exec(
    head.split(/\r?\n\r?\n/, 1)[0] ?? "",
  );
  return match?.[1]?.trim() ?? "";
}
