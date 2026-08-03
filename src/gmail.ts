/**
 * Gmail inbound sync over IMAP (imapflow) + outbound SMTP (nodemailer),
 * app-password auth, any number of accounts.
 *
 * One-way inbound: mailboxes are opened read-only, so server state is never
 * modified. The sync is delta-only: a per-folder UIDVALIDITY:last_uid
 * high-water mark lives in the index, and a no-change poll costs one STATUS
 * round trip per folder. Server-side deletions are not mirrored; the room
 * only ever grows. A ConnectionCache keeps one TLS+LOGIN session warm per
 * address between cycles; the Sent folder name (discovered via SPECIAL-USE)
 * is cached in the index. Losing any of this state is safe: it degrades to
 * a full-window re-list, and sha dedup in storeMessage prevents duplicates.
 */

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

import type { AccountConfig, Config } from "./config.js";
import { accountsFor } from "./config.js";
import { gmailAppPassword } from "./creds.js";
import type { Layout } from "./layout.js";
import type { Index } from "./state.js";
import type { Ledger } from "./ledger.js";
import { storeMessage } from "./store.js";
import { gmailLabelsToTags } from "./gmail_labels.js";
import { Rejection, toWire } from "./intents.js";
import { log } from "./log.js";

const IMAP_HOST = "imap.gmail.com";
const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 587;
/**
 * The "instant first touch" window: the folder fast-sync downloads bodies
 * for only the most recent mail so a fresh account is usable in seconds.
 * Everything older arrives as metadata through the time-boxed backfill.
 */
const FAST_SYNC_DAYS = 30;
const MAX_PER_FOLDER = 500;
const FETCH_CHUNK = 50;
const FALLBACK_SENT = "[Gmail]/Sent Mail";

/** The subset of imapflow's ENVELOPE the All-Mail metadata pass reads. */
export interface GmailEnvelope {
  date?: Date | string;
  subject?: string;
  messageId?: string;
  from?: Array<{ name?: string; address?: string }>;
  to?: Array<{ name?: string; address?: string }>;
}

/** The slice of imapflow the sync uses; tests fake this. */
export interface GmailClientLike {
  noop(): Promise<unknown>;
  status(
    mailbox: string,
    query: { uidNext: boolean; uidValidity: boolean },
  ): Promise<{ uidNext?: number; uidValidity?: number | bigint }>;
  mailboxOpen(
    mailbox: string,
    opts: { readOnly: boolean },
  ): Promise<{
    uidValidity: number | bigint;
    exists?: number;
    uidNext?: number | bigint;
  }>;
  search(query: object, opts: { uid: boolean }): Promise<number[] | false>;
  fetch(
    range: number[] | string,
    query: {
      source?: boolean;
      envelope?: boolean;
      labels?: boolean;
      internalDate?: boolean;
      size?: boolean;
      emailId?: boolean;
    },
    opts: { uid: boolean },
  ): AsyncIterable<{
    uid: number;
    source?: Buffer;
    envelope?: GmailEnvelope;
    labels?: Set<string> | string[];
    internalDate?: Date;
    size?: number;
    emailId?: string;
  }>;
  list(): Promise<Array<{ path: string; specialUse?: string }>>;
  messageMove(
    range: number[] | string,
    destination: string,
    opts: { uid: boolean },
  ): Promise<unknown>;
  messageCopy(
    range: number[] | string,
    destination: string,
    opts: { uid: boolean },
  ): Promise<unknown>;
  append(
    mailbox: string,
    content: Buffer | string,
    flags?: string[],
    date?: Date,
  ): Promise<{ uid?: number; destination?: string } | false>;
  logout(): Promise<void>;
  close(): void;
}

export type GmailClientFactory = (
  address: string,
  password: string,
) => Promise<GmailClientLike>;

export class GmailAuthError extends Error {}

/**
 * ImapFlow emits 'error' on the client for post-connect failures — and the
 * broker caches connections between tool calls, so Gmail dropping an idle
 * session minutes after the last command emits 'error' with nobody around.
 * An unhandled 'error' event kills the Node process (this took the whole
 * MCP server down: "Server disconnected" with no visible reason). Attach a
 * listener that just logs; ConnectionCache.get() revalidates with NOOP and
 * reconnects on next use, so a dead cached connection is otherwise fine.
 */
export function attachConnectionErrorLogger(
  client: { on(event: string, handler: (err: Error) => void): unknown },
  address: string,
): void {
  client.on("error", (err) => {
    log.warn(`gmail: connection for ${address} errored (idle drop?): ${err}`);
  });
}

const defaultClientFactory: GmailClientFactory = async (address, password) => {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: address, pass: password },
    logger: false,
  });
  attachConnectionErrorLogger(client, address);
  try {
    await client.connect();
  } catch (err) {
    const e = err as {
      authenticationFailed?: boolean;
      response?: string;
      responseText?: string;
      message?: string;
    };
    if (
      e?.authenticationFailed ||
      e?.response?.includes("AUTHENTICATIONFAILED")
    ) {
      throw new GmailAuthError(String(e.responseText || e.message || err));
    }
    throw err;
  }
  return client as unknown as GmailClientLike;
};

/**
 * One IMAP LOGIN round trip, used by `mailroom set-gmail-password` to test
 * the credential at storage time. Throws GmailAuthError when the server
 * refuses the login; connection problems propagate as-is.
 */
export async function verifyLogin(
  address: string,
  password: string,
  clientFactory: GmailClientFactory = defaultClientFactory,
): Promise<void> {
  const client = await clientFactory(address, password);
  try {
    await client.logout();
  } catch {
    client.close();
  }
}

/**
 * Keeps one logged-in IMAP client warm per address between sync cycles.
 * get() revalidates with NOOP and transparently reconnects. Not safe for
 * concurrent use — the broker cycle lock serializes all access.
 */
export class ConnectionCache {
  private clients = new Map<string, GmailClientLike>();

  async get(
    address: string,
    password: string,
    factory: GmailClientFactory,
  ): Promise<GmailClientLike> {
    const cached = this.clients.get(address);
    if (cached) {
      try {
        await cached.noop();
        return cached;
      } catch {
        await this.discard(address);
      }
    }
    const client = await factory(address, password);
    this.clients.set(address, client);
    return client;
  }

  async discard(address?: string): Promise<void> {
    const targets = address ? [address] : [...this.clients.keys()];
    for (const addr of targets) {
      const client = this.clients.get(addr);
      this.clients.delete(addr);
      if (client) {
        try {
          await client.logout();
        } catch {
          try {
            client.close();
          } catch {
            /* gone */
          }
        }
      }
    }
  }
}

export interface GmailSyncOptions {
  clientFactory?: GmailClientFactory;
  connCache?: ConnectionCache;
  /** injectable for tests; default reads creds files / env */
  getPassword?: (layout: Layout, cfg: Config, address: string) => string | null;
  /**
   * Absolute time (opts.now clock) the historical backfill must yield by.
   * The broker passes cycle start + ~2.5s so a backlog never stretches a
   * tool call; unset defaults to that same budget from now.
   */
  historyDeadline?: number;
  /** test seam for the deadline clock */
  now?: () => number;
}

export async function sync(
  layout: Layout,
  index: Index,
  ledger: Ledger,
  cfg: Config,
  explained: Set<string>,
  opts: GmailSyncOptions = {},
): Promise<void> {
  const factory = opts.clientFactory ?? defaultClientFactory;
  const getPassword = opts.getPassword ?? gmailAppPassword;
  const ownsCache = !opts.connCache;
  const cache = opts.connCache ?? new ConnectionCache();
  try {
    for (const acct of accountsFor(cfg, "gmail")) {
      const address = acct.address;
      const password = getPassword(layout, cfg, address);
      if (!password) {
        log.info(`gmail: ${address} configured but no app password; skipping`);
        continue;
      }
      if (!/^[\x00-\x7f]*$/.test(password)) {
        log.warn(
          `gmail: stored app password for ${address} contains non-ASCII characters ` +
            "(dead-key or paste artifact?); re-store it — skipping sync",
        );
        continue;
      }
      layout.ensureAccount(address);
      try {
        const client = await cache.get(address, password, factory);
        const [sentName, sentFromCache] = await sentFolder(
          client,
          index,
          address,
        );
        const folders: Array<[string, string]> = [
          ["INBOX", "INBOX"],
          ["Sent", sentName],
        ];
        for (const [local, remote] of folders) {
          try {
            await syncFolder(
              layout,
              index,
              ledger,
              client,
              address,
              local,
              remote,
              explained,
            );
          } catch (err) {
            if (local === "Sent" && sentFromCache) {
              // cached name may be stale (folder renamed / language
              // changed); force rediscovery next cycle
              index.setState(`gmail:${address}:sent_folder`, "");
            }
            log.error(`gmail: sync of ${remote} for ${address} failed: ${err}`);
          }
        }
        // Additive All-Mail pass: new arrivals forward, then the time-boxed
        // historical backfill — metadata-only rows covering the ENTIRE
        // mailbox; bodies are fetched on demand later.
        try {
          await syncAllMail(index, ledger, client, address, {
            deadline:
              opts.historyDeadline ??
              (opts.now ?? Date.now)() + DEFAULT_BACKFILL_BUDGET_MS,
            now: opts.now ?? Date.now,
          });
        } catch (err) {
          log.error(
            `gmail: All-Mail archive scan for ${address} failed: ${err}`,
          );
        }
      } catch (err) {
        await cache.discard(address); // connection-level failure: reconnect next cycle
        log.error(`gmail: sync for ${address} failed: ${err}`);
      }
    }
  } finally {
    if (ownsCache) await cache.discard();
  }
}

const ALL_MAIL_CHUNK = 200;
// safety cap on forward (new-arrival) UIDs per cycle; the high-water mark
// makes this resumable, so a burst just spans several cycles.
const ALL_MAIL_MAX_NEW = 5000;
/**
 * How many of the newest All-Mail UIDs get their labels re-read, to notice a
 * message archived (or un-archived) in Gmail's own UI. One metadata chunk;
 * recent mail is where folder changes actually happen.
 */
const RELABEL_WINDOW = 200;
/**
 * How often that re-read is allowed to run, per account.
 *
 * It costs the quiet-cycle optimisation: a caught-up mailbox normally settles
 * for one STATUS round trip, and noticing a label change means actually opening
 * All Mail and fetching metadata. Throttling keeps that to roughly one extra
 * fetch per interval instead of one per tool call, at the price of taking up to
 * this long to notice.
 */
const RELABEL_INTERVAL_MS = 10 * 60 * 1000;

function relabelKey(address: string): string {
  return `gmail:${address}:relabel_at`;
}

function relabelDue(index: Index, address: string, nowMs: number): boolean {
  const raw = Number(index.getState(relabelKey(address)) ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return false; // stamped on catch-up
  return nowMs - raw >= RELABEL_INTERVAL_MS;
}

function stampRelabel(index: Index, address: string, nowMs: number): void {
  index.setState(relabelKey(address), String(nowMs));
}
/** default per-cycle budget for the historical backfill (spec: 2.5s). */
export const DEFAULT_BACKFILL_BUDGET_MS = 2500;

const ALL_MAIL_META_FIELDS = {
  envelope: true,
  labels: true,
  internalDate: true,
  size: true,
  emailId: true,
} as const;

/** Where a metadata-only row "lives" for display, derived from its labels. */
function metaFolderFor(tags: string[]): string {
  if (tags.includes("INBOX")) return "INBOX";
  if (tags.includes("SENT")) return "Sent";
  return "Archive";
}

/** The metadata slice of one All-Mail fetch result. */
interface MetaFetchMsg {
  uid: number;
  envelope?: GmailEnvelope;
  labels?: Set<string> | string[];
  internalDate?: Date;
  emailId?: string;
}

/** Insert one All-Mail fetch result as a metadata-only row. false = dup. */
function indexMetaMessage(
  index: Index,
  address: string,
  msg: MetaFetchMsg,
): boolean {
  const tags = gmailLabelsToTags(msg.labels ?? []);
  const providerId = msg.emailId ? String(msg.emailId) : `uid:${msg.uid}`;
  const key = `gm:${providerId}`;
  const env = msg.envelope ?? {};
  const rfcId = env.messageId ? String(env.messageId) : undefined;
  // Already indexed: not a new row, but its labels are FRESH from the provider,
  // so this is the one chance to notice the message was archived or moved back
  // to the inbox outside Mailroom (web UI, a filter, a phone). Without this the
  // row keeps whatever folder it had when first seen, forever.
  if (index.hasSha(key) || index.hasProviderMsg(address, providerId)) {
    index.reconcileFolder(address, providerId, metaFolderFor(tags), tags);
    return false;
  }
  if (rfcId && index.hasRfcMessageId(address, rfcId)) return false;
  const epoch =
    msg.internalDate instanceof Date
      ? Math.floor(msg.internalDate.getTime() / 1000)
      : env.date
        ? Math.floor(new Date(env.date).getTime() / 1000)
        : 0;
  const fromText = (env.from ?? [])
    .map((a) =>
      a.address ? (a.name ? `${a.name} <${a.address}>` : a.address) : "",
    )
    .filter(Boolean)
    .join(", ");
  const toText = (env.to ?? [])
    .map((a) => a.address ?? "")
    .filter(Boolean)
    .join(", ");
  index.insertMessage({
    sha: key,
    account: address,
    folder: metaFolderFor(tags),
    filename: "",
    path: "",
    date: env.date ? new Date(env.date).toUTCString() : "",
    epoch,
    from: fromText,
    to: toText,
    subject: env.subject ?? "",
    body: "",
    labels: tags,
    gmailId: providerId,
    rfcMessageId: rfcId,
    metaOnly: true,
  });
  return true;
}

/**
 * All-Mail metadata sync: the room's view of the ENTIRE mailbox.
 *
 * All Mail holds exactly one copy of every message with its full X-GM-LABELS
 * set. Two passes, both metadata-only (bodies are fetched on demand later),
 * both read-only, both deduped against folder-synced full rows by provider
 * message id / RFC Message-ID:
 *
 *  1. forward: uids above the high-water mark (new arrivals) — small,
 *     bounded, never deferred;
 *  2. backfill: descending uid ranges from the low-water floor toward 1,
 *     strictly time-boxed by `deadline` so a 100k-message history grows the
 *     index across many cycles without ever stretching a tool call.
 *
 * Progress lives in the structured sync_state row (uidValidity, lastUid,
 * lowUid, status); a POC2 kv watermark is migrated on first sight, with the
 * floor set to that watermark so history the old code skipped (INBOX/SENT-
 * labeled) is re-scanned exactly once.
 */
async function syncAllMail(
  index: Index,
  ledger: Ledger,
  client: GmailClientLike,
  address: string,
  budget: { deadline: number; now: () => number },
): Promise<void> {
  // discovered by sentFolder() from its single list() call and cached
  const remote =
    index.getState(`gmail:${address}:all_folder`) || "[Gmail]/All Mail";
  let state = index.getSyncState(address, remote);

  if (!state) {
    // one-time migration of the POC2 forward-scan watermark
    const legacy = index.getState(`gmail:${address}:allmail`);
    if (legacy) {
      const [v, u] = legacy.split(":", 2);
      if (Number.isFinite(Number(v)) && Number.isFinite(Number(u))) {
        state = {
          account: address,
          mailbox: remote,
          uidValidity: Number(v),
          lastUid: Number(u),
          // rescan below the old mark: the POC2 pass skipped INBOX/SENT-
          // labeled history; sha/provider-id dedup keeps this idempotent
          lowUid: Number(u),
          cursor: null,
          status: "in_progress",
          totalExpected: null,
        };
        index.putSyncState(state);
      }
    }
  }

  // A mailbox that was already caught up before this code existed has no
  // re-read stamp, and an unset stamp is never "due" — so start its clock now
  // instead of leaving that account permanently blind to label changes.
  if (
    state &&
    state.status === "caught_up" &&
    !index.getState(relabelKey(address))
  ) {
    stampRelabel(index, address, budget.now());
  }

  // quiet-cycle probe: when fully caught up, one STATUS round trip decides
  if (state && state.status === "caught_up") {
    try {
      const status = await client.status(remote, {
        uidNext: true,
        uidValidity: true,
      });
      const validity = Number(status.uidValidity ?? NaN);
      const uidNext = Number(status.uidNext ?? NaN);
      if (
        validity === state.uidValidity &&
        Number.isFinite(uidNext) &&
        uidNext <= state.lastUid + 1 &&
        // ...unless a label re-read is due: nothing NEW has arrived, but a
        // message may have been archived in Gmail's UI, which changes no UID and
        // so is invisible to every other check here
        !relabelDue(index, address, budget.now())
      ) {
        return;
      }
    } catch {
      /* STATUS unsupported or transient: fall through to a full open */
    }
  }

  const info = await client.mailboxOpen(remote, { readOnly: true });
  const uidValidity = Number(info.uidValidity ?? 0);
  if (state && state.uidValidity !== uidValidity) {
    log.info(
      `gmail: ${remote} uidvalidity changed (${state.uidValidity} -> ${uidValidity}); rescanning`,
    );
    state = null; // mailbox rebuilt; uids are not comparable
  }
  if (!state) {
    // first touch: new arrivals start at the current top; ALL history below
    // belongs to the backfill
    const top = Math.max(0, Number(info.uidNext ?? 1) - 1);
    state = {
      account: address,
      mailbox: remote,
      uidValidity,
      lastUid: top,
      lowUid: top,
      cursor: null,
      status: top > 0 ? "in_progress" : "caught_up",
      totalExpected: info.exists ?? null,
    };
    index.putSyncState(state);
  }

  let indexed = 0;

  // ---- pass 1: forward (new arrivals) -------------------------------
  const found = await client.search(
    { uid: `${state.lastUid + 1}:*` },
    { uid: true },
  );
  const newUids = (found || [])
    .filter((u) => u > state.lastUid)
    .sort((a, b) => a - b)
    .slice(0, ALL_MAIL_MAX_NEW);
  for (let i = 0; i < newUids.length; i += ALL_MAIL_CHUNK) {
    const chunk = newUids.slice(i, i + ALL_MAIL_CHUNK);
    // fetch the whole chunk first: the transaction below must stay free of
    // awaits (a write txn held across network I/O would pin the WAL)
    const batch: MetaFetchMsg[] = [];
    for await (const msg of client.fetch(chunk, ALL_MAIL_META_FIELDS, {
      uid: true,
    })) {
      batch.push(msg);
    }
    // one commit per chunk instead of per row (~20-30x on this path), and
    // the rows land atomically with the watermark that covers them
    indexed += index.transaction(() => {
      let count = 0;
      for (const msg of batch) {
        if (indexMetaMessage(index, address, msg)) count += 1;
        state.lastUid = Math.max(state.lastUid, msg.uid);
      }
      index.putSyncState(state);
      return count;
    });
  }

  // ---- pass 2: historical backfill (time-boxed) ----------------------
  while (state.lowUid > 0 && budget.now() < budget.deadline) {
    const hi = state.lowUid;
    const lo = Math.max(1, hi - ALL_MAIL_CHUNK + 1);
    const batch: MetaFetchMsg[] = [];
    for await (const msg of client.fetch(`${lo}:${hi}`, ALL_MAIL_META_FIELDS, {
      uid: true,
    })) {
      batch.push(msg);
    }
    indexed += index.transaction(() => {
      let count = 0;
      for (const msg of batch) {
        if (indexMetaMessage(index, address, msg)) count += 1;
      }
      state.lowUid = lo - 1;
      if (state.lowUid === 0) {
        state.status = "caught_up";
        // the backfill just read every label; start the re-read clock here
        // rather than firing one immediately afterwards
        stampRelabel(index, address, budget.now());
      }
      index.putSyncState(state);
      return count;
    });
  }

  // ---- pass 3: re-read labels on recent mail (folder drift) ----------
  //
  // Passes 1 and 2 only ever look at UIDs they have not seen: forward above the
  // watermark, backward below the floor. Archiving in Gmail's web UI drops the
  // INBOX label but keeps the SAME All-Mail UID, so a message archived after
  // being indexed is never looked at again and the room shows it in the inbox
  // forever. (Microsoft gets this from the Graph inbox delta reporting the
  // message as removed; IMAP offers no equivalent.)
  //
  // So re-fetch metadata for a bounded window of the newest UIDs and let
  // indexMetaMessage reconcile the folder. Metadata only, one chunk, and only
  // once the backfill is done so it never competes with it. Bounded by design:
  // recent mail is where archiving happens, and an unbounded re-scan of a 100k
  // mailbox every cycle is not affordable.
  if (
    state.status === "caught_up" &&
    state.lastUid > 0 &&
    // never on a cycle that already did real work: the backfill just read these
    // labels, and piling a re-read on top would double-fetch for nothing
    indexed === 0 &&
    relabelDue(index, address, budget.now())
  ) {
    const lo = Math.max(1, state.lastUid - RELABEL_WINDOW + 1);
    try {
      const batch: MetaFetchMsg[] = [];
      for await (const msg of client.fetch(
        `${lo}:${state.lastUid}`,
        ALL_MAIL_META_FIELDS,
        { uid: true },
      )) {
        batch.push(msg);
      }
      index.transaction(() => {
        for (const msg of batch) indexMetaMessage(index, address, msg);
      });
      stampRelabel(index, address, budget.now());
    } catch (err) {
      // a failed re-read costs freshness, never the sync
      log.warn(`gmail: label re-read for ${address} skipped: ${err}`);
    }
  }

  if (indexed) {
    log.info(
      `gmail: indexed ${indexed} messages (metadata) from ${remote} (${address}); ` +
        `backfill ${state.status === "caught_up" ? "caught up" : `at uid ${state.lowUid}`}`,
    );
    ledger.append("sync_archive_meta", {
      account: address,
      count: indexed,
      backfill: state.status,
    });
  }
}

/**
 * Sent folder name and whether it came from the index cache. Discovery uses
 * SPECIAL-USE (Gmail localizes folder names per account language).
 */
async function sentFolder(
  client: GmailClientLike,
  index: Index,
  address: string,
): Promise<[string, boolean]> {
  const stateKey = `gmail:${address}:sent_folder`;
  const cached = index.getState(stateKey);
  if (cached) return [cached, true];
  let found: string | undefined;
  let allFound: string | undefined;
  try {
    const entries = await client.list();
    found = entries.find((e) => e.specialUse === "\\Sent")?.path;
    // discover the All-Mail folder from the SAME list() call so the archive
    // pass never needs a second round trip
    allFound = entries.find((e) => e.specialUse === "\\All")?.path;
  } catch {
    found = undefined;
  }
  const name = found || FALLBACK_SENT;
  index.setState(stateKey, name);
  index.setState(`gmail:${address}:all_folder`, allFound || "[Gmail]/All Mail");
  return [name, false];
}

async function syncFolder(
  layout: Layout,
  index: Index,
  ledger: Ledger,
  client: GmailClientLike,
  address: string,
  local: string,
  remote: string,
  explained: Set<string>,
): Promise<void> {
  const stateKey = `gmail:${address}:${remote}`;
  const stored = index.getState(stateKey);
  let knownValidity: number | null = null;
  let lastUid = 0;
  if (stored) {
    const [validityS, uidS] = stored.split(":", 2);
    const v = Number(validityS);
    const u = Number(uidS);
    if (Number.isFinite(v) && Number.isFinite(u)) {
      knownValidity = v;
      lastUid = u;
    }
  }

  if (knownValidity !== null) {
    // cheap probe: no new UIDs can exist while UIDNEXT == last_uid + 1,
    // so a no-change cycle never opens the mailbox
    try {
      const status = await client.status(remote, {
        uidNext: true,
        uidValidity: true,
      });
      const validity = Number(status.uidValidity ?? NaN);
      const uidNext = Number(status.uidNext ?? NaN);
      if (
        validity === knownValidity &&
        Number.isFinite(uidNext) &&
        uidNext <= lastUid + 1
      ) {
        return;
      }
    } catch {
      /* STATUS unsupported or transient failure: fall through */
    }
  }

  const info = await client.mailboxOpen(remote, { readOnly: true });
  const uidValidity = Number(info.uidValidity ?? 0);
  const validityChanged =
    knownValidity !== null && knownValidity !== uidValidity;
  if (validityChanged) {
    lastUid = 0; // mailbox was rebuilt; UIDs are not comparable
  }

  let uids: number[];
  if (lastUid) {
    const found = await client.search(
      { uid: `${lastUid + 1}:*` },
      { uid: true },
    );
    uids = (found || []).filter((u) => u > lastUid);
  } else {
    const since = new Date(Date.now() - FAST_SYNC_DAYS * 86400_000);
    const found = await client.search({ since }, { uid: true });
    uids = found || [];
  }
  uids = uids.sort((a, b) => a - b).slice(-MAX_PER_FOLDER);

  let storedCount = 0;
  for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
    const chunk = uids.slice(i, i + FETCH_CHUNK);
    for await (const msg of client.fetch(
      chunk,
      { source: true, emailId: true, labels: true },
      { uid: true },
    )) {
      if (!msg.source) continue;
      const dest = await storeMessage(layout, index, ledger, {
        account: address,
        folder: local,
        raw: msg.source,
        explained,
        providerMsgId: msg.emailId ? String(msg.emailId) : undefined,
        labels: msg.labels ? gmailLabelsToTags(msg.labels) : undefined,
      });
      if (dest) storedCount += 1;
    }
  }
  if (uids.length) {
    index.setState(stateKey, `${uidValidity}:${Math.max(...uids, lastUid)}`);
  } else if (!stored || validityChanged) {
    index.setState(stateKey, `${uidValidity}:0`);
  }
  if (storedCount) {
    log.info(
      `gmail: stored ${storedCount} new messages from ${remote} (${address})`,
    );
  }
}

/**
 * Download raw bodies for metadata-only rows by provider message id
 * (X-GM-MSGID; legacy `uid:<n>` ids fetch by uid). Read-only, one All-Mail
 * open per call. Returns sha -> raw for the messages the server still has;
 * missing ones are simply absent from the map.
 */
export async function fetchBodies(
  layout: Layout,
  index: Index,
  cfg: Config,
  acct: AccountConfig,
  wants: Array<{ sha: string; providerMsgId: string }>,
  opts: GmailSyncOptions = {},
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!wants.length) return out;
  const getPassword = opts.getPassword ?? gmailAppPassword;
  const password = getPassword(layout, cfg, acct.address);
  if (!password) {
    throw new Rejection(
      "needs_auth",
      `gmail app password for ${acct.address} is not available — ` +
        `run \`mail login ${acct.address}\` and finish the setup page`,
    );
  }
  const factory = opts.clientFactory ?? defaultClientFactory;
  const ownsCache = !opts.connCache;
  const cache = opts.connCache ?? new ConnectionCache();
  try {
    const client = await cache.get(acct.address, password, factory);
    const remote =
      index.getState(`gmail:${acct.address}:all_folder`) ||
      (await allMailbox(client));
    await client.mailboxOpen(remote, { readOnly: true });
    for (const want of wants) {
      let uids: number[];
      if (want.providerMsgId.startsWith("uid:")) {
        const uid = Number(want.providerMsgId.slice(4));
        uids = Number.isFinite(uid) && uid > 0 ? [uid] : [];
      } else {
        const found = await client.search(
          { emailId: want.providerMsgId },
          { uid: true },
        );
        uids = found || [];
      }
      const uid = uids[0];
      if (uid === undefined) continue; // gone server-side; caller reports it
      for await (const msg of client.fetch(
        [uid],
        { source: true },
        { uid: true },
      )) {
        if (msg.source) out.set(want.sha, msg.source);
      }
    }
    return out;
  } finally {
    if (ownsCache) await cache.discard();
  }
}

export type SmtpSender = (opts: {
  address: string;
  password: string;
  envelopeTo: string[];
  wire: Buffer;
}) => Promise<void>;

const defaultSmtpSender: SmtpSender = async ({
  address,
  password,
  envelopeTo,
  wire,
}) => {
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    requireTLS: true,
    auth: { user: address, pass: password },
    connectionTimeout: 60_000,
    socketTimeout: 60_000,
  });
  try {
    // explicit envelope: exactly the validated recipient set; raw preserves
    // the sha-validated bytes (nodemailer only dot-stuffs for the wire)
    await transport.sendMail({
      envelope: { from: address, to: envelopeTo },
      raw: wire,
    });
  } finally {
    transport.close();
  }
};

/** Deliver exact MIME bytes via Gmail SMTP; Rejection on missing credential. */
export async function sendMime(
  layout: Layout,
  cfg: Config,
  acct: AccountConfig,
  mime: Buffer,
  recipients: string[],
  opts: {
    smtpSender?: SmtpSender;
    getPassword?: GmailSyncOptions["getPassword"];
  } = {},
): Promise<void> {
  const getPassword = opts.getPassword ?? gmailAppPassword;
  const password = getPassword(layout, cfg, acct.address);
  if (!password) {
    throw new Rejection(
      "delivery_unavailable",
      `gmail app password for ${acct.address} is not available (set it in the ` +
        "extension settings or run `mailroom set-gmail-password`)",
    );
  }
  if (!/^[\x00-\x7f]*$/.test(password)) {
    throw new Rejection(
      "delivery_unavailable",
      `the stored gmail app password for ${acct.address} contains non-ASCII ` +
        "characters (likely a paste artifact); re-store it",
    );
  }
  const sender = opts.smtpSender ?? defaultSmtpSender;
  await sender({
    address: acct.address,
    password,
    envelopeTo: recipients,
    wire: toWire(mime),
  });
}

// ---- folder changes (archive / move) --------------------------------
//
// The provider-abstracted folder-change primitive, Gmail side. Gmail models
// folders as labels: archiving removes the INBOX label, moving adds a target
// label — over IMAP that is MOVE out of INBOX (to the \All mailbox) and COPY
// into a target mailbox. `mail archive` / `mail unarchive` are presets into
// this primitive; phase 2's `mail move` supplies other label sets. The
// message is identified by its Message-ID header, so nothing needs to be
// stored at sync time. NEVER destructive: only MOVE/COPY between mailboxes,
// never toward Trash, never STORE \Deleted, never EXPUNGE.

export interface FolderChange {
  /** RFC 2822 Message-ID, including angle brackets. */
  messageId: string;
  removeLabels: string[];
  addLabels: string[];
}

async function findByMessageId(
  client: GmailClientLike,
  mailbox: string,
  messageId: string,
  opts: { readOnly: boolean },
): Promise<number[]> {
  await client.mailboxOpen(mailbox, { readOnly: opts.readOnly });
  const found = await client.search(
    { header: { "message-id": messageId } },
    { uid: true },
  );
  return found || [];
}

async function allMailbox(client: GmailClientLike): Promise<string> {
  try {
    const entries = await client.list();
    const all = entries.find((e) => e.specialUse === "\\All")?.path;
    if (all) return all;
  } catch {
    /* fall through */
  }
  return "[Gmail]/All Mail";
}

export async function applyFolderChange(
  layout: Layout,
  cfg: Config,
  acct: AccountConfig,
  change: FolderChange,
  opts: GmailSyncOptions = {},
): Promise<"applied" | "noop"> {
  const getPassword = opts.getPassword ?? gmailAppPassword;
  const password = getPassword(layout, cfg, acct.address);
  if (!password) {
    throw new Rejection(
      "needs_auth",
      `gmail app password for ${acct.address} is not available — ` +
        `run \`mail login ${acct.address}\` and finish the setup page`,
    );
  }
  const factory = opts.clientFactory ?? defaultClientFactory;
  const ownsCache = !opts.connCache;
  const cache = opts.connCache ?? new ConnectionCache();
  try {
    const client = await cache.get(acct.address, password, factory);
    const removesInbox = change.removeLabels.includes("INBOX");
    const addsInbox = change.addLabels.includes("INBOX");

    if (removesInbox && change.addLabels.length === 0) {
      // archive: drop the INBOX label = move INBOX -> \All
      const uids = await findByMessageId(client, "INBOX", change.messageId, {
        readOnly: false,
      });
      const all = await allMailbox(client);
      if (uids.length) {
        await client.messageMove(uids, all, { uid: true });
        return "applied";
      }
      const elsewhere = await findByMessageId(client, all, change.messageId, {
        readOnly: true,
      });
      if (elsewhere.length) return "noop"; // already archived
      throw new Rejection(
        "message_not_found",
        `no message with Message-ID ${change.messageId} found in INBOX or ${all}`,
      );
    }

    if (addsInbox && change.removeLabels.length === 0) {
      // unarchive: add the INBOX label = copy \All -> INBOX
      const inInbox = await findByMessageId(client, "INBOX", change.messageId, {
        readOnly: true,
      });
      if (inInbox.length) return "noop"; // already in the inbox
      const all = await allMailbox(client);
      const uids = await findByMessageId(client, all, change.messageId, {
        readOnly: false,
      });
      if (uids.length) {
        await client.messageCopy(uids, "INBOX", { uid: true });
        return "applied";
      }
      throw new Rejection(
        "message_not_found",
        `no message with Message-ID ${change.messageId} found in ${all}`,
      );
    }

    // phase 2 (`mail move --to X`): remove INBOX + add a target label = MOVE
    // INBOX -> X (or COPY \All -> X when already archived). Not exposed yet.
    throw new Rejection(
      "unsupported_change",
      `label change not supported yet (remove: ${change.removeLabels.join(",") || "-"}; ` +
        `add: ${change.addLabels.join(",") || "-"})`,
    );
  } finally {
    if (ownsCache) await cache.discard();
  }
}

// ---- provider drafts (upload / delete) -------------------------------
//
// The provider-abstracted draft primitive, Gmail side. A draft is uploaded
// by IMAP APPEND into the \Drafts special-use mailbox with the \Draft flag,
// so it appears in the user's Gmail Drafts and can be reviewed and sent from
// any Gmail client. Deleting a draft is a reversible MOVE from \Drafts to
// \Trash (identified by the draft's Message-ID header) — NEVER a STORE
// \Deleted / EXPUNGE, matching the non-destructive invariant of the
// folder-change code above. The trashed draft is recoverable from Gmail's
// Trash until Gmail's own retention removes it.

const FALLBACK_DRAFTS = "[Gmail]/Drafts";
const FALLBACK_TRASH = "[Gmail]/Trash";

async function specialMailbox(
  client: GmailClientLike,
  use: string,
  fallback: string,
): Promise<string> {
  try {
    const entries = await client.list();
    const hit = entries.find((e) => e.specialUse === use)?.path;
    if (hit) return hit;
  } catch {
    /* fall through to the well-known name */
  }
  return fallback;
}

/**
 * APPEND a draft MIME message into the account's Gmail Drafts mailbox with
 * the \Draft flag. Returns the assigned UID when the server reports one.
 * The bytes are normalized to CRLF wire form, exactly like sends.
 */
export async function uploadDraft(
  layout: Layout,
  cfg: Config,
  acct: AccountConfig,
  mime: Buffer,
  opts: GmailSyncOptions = {},
): Promise<{ uid?: number; mailbox: string }> {
  const getPassword = opts.getPassword ?? gmailAppPassword;
  const password = getPassword(layout, cfg, acct.address);
  if (!password) {
    throw new Rejection(
      "needs_auth",
      `gmail app password for ${acct.address} is not available — ` +
        `run \`mail login ${acct.address}\` and finish the setup page`,
    );
  }
  const factory = opts.clientFactory ?? defaultClientFactory;
  const ownsCache = !opts.connCache;
  const cache = opts.connCache ?? new ConnectionCache();
  try {
    const client = await cache.get(acct.address, password, factory);
    const drafts = await specialMailbox(client, "\\Drafts", FALLBACK_DRAFTS);
    const res = await client.append(drafts, toWire(mime), ["\\Draft"]);
    if (res === false) {
      throw new Rejection(
        "draft_upload_failed",
        `Gmail refused the APPEND into ${drafts} for ${acct.address}`,
      );
    }
    return { uid: res.uid, mailbox: drafts };
  } finally {
    if (ownsCache) await cache.discard();
  }
}

/**
 * Reversibly delete a Gmail draft: find it in \Drafts by Message-ID and MOVE
 * it to \Trash. Returns "applied" when moved, "noop" when no such draft is in
 * Drafts (already gone). Never expunges.
 */
export async function deleteDraft(
  layout: Layout,
  cfg: Config,
  acct: AccountConfig,
  messageId: string,
  opts: GmailSyncOptions = {},
): Promise<"applied" | "noop"> {
  const getPassword = opts.getPassword ?? gmailAppPassword;
  const password = getPassword(layout, cfg, acct.address);
  if (!password) {
    throw new Rejection(
      "needs_auth",
      `gmail app password for ${acct.address} is not available — ` +
        `run \`mail login ${acct.address}\` and finish the setup page`,
    );
  }
  const factory = opts.clientFactory ?? defaultClientFactory;
  const ownsCache = !opts.connCache;
  const cache = opts.connCache ?? new ConnectionCache();
  try {
    const client = await cache.get(acct.address, password, factory);
    const drafts = await specialMailbox(client, "\\Drafts", FALLBACK_DRAFTS);
    const uids = await findByMessageId(client, drafts, messageId, {
      readOnly: false,
    });
    if (!uids.length) return "noop";
    const trash = await specialMailbox(client, "\\Trash", FALLBACK_TRASH);
    await client.messageMove(uids, trash, { uid: true });
    return "applied";
  } finally {
    if (ownsCache) await cache.discard();
  }
}
