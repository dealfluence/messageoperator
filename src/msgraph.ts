/**
 * Microsoft inbound sync + outbound send via the Graph API, any number of
 * accounts, one shared MSAL token cache.
 *
 * Auth (the macOS/POC2 way): authorization-code + PKCE on a loopback
 * redirect. There is no console under Claude Desktop and no extra MCP tool —
 * login is LAZY: when a configured account has no cached token, the broker
 * (during a pull) starts a one-shot 127.0.0.1 listener, opens the default
 * browser at the sign-in URL, and keeps syncing everything else. The pending
 * URL is published in `mail status` so the agent can hand it to the user;
 * `mail login` re-triggers the flow. Tokens land in the shared cache file
 * (broker/credentials/msal_token_cache.json — the same unified schema MSAL
 * Python used) and are matched to accounts by username, not accounts[0].
 *
 * Inbound sync uses Graph delta queries exactly like the Python POC: first
 * walk windowed to WINDOW_DAYS, then deltaLink-only polls; HTTP 410 falls
 * back to a fresh walk; @removed entries are ledgered but the local copy is
 * kept — the room only ever grows.
 */

import fs from "node:fs";
import http from "node:http";
import { spawn, exec } from "node:child_process";
import { AddressInfo } from "node:net";

import {
  PublicClientApplication,
  CryptoProvider,
  type AccountInfo,
} from "@azure/msal-node";

import type { AccountConfig, Config } from "./config.js";
import { accountsFor } from "./config.js";
import type { Layout } from "./layout.js";
import type { Index } from "./state.js";
import type { Ledger } from "./ledger.js";
import { storeMessage } from "./store.js";
import { Rejection } from "./intents.js";
import { log } from "./log.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const AUTHORITY = "https://login.microsoftonline.com/common";
// offline_access / openid / profile are reserved scopes MSAL adds itself.
const SCOPES = ["Mail.ReadWrite", "Mail.Send"];
/** "instant first touch": bodies only for recent mail; history backfills. */
const FAST_SYNC_DAYS = 30;
const MAX_PER_FOLDER = 500;
const PAGE_SIZE = 50;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** default per-cycle budget for the historical backfill (spec: 2.5s). */
const DEFAULT_BACKFILL_BUDGET_MS = 2500;
/** sync_state "mailbox" key for the whole-mailbox history walk. */
const HISTORY_MAILBOX = "graph:history";
const HISTORY_PAGE = 100;
/**
 * Well-known folders whose history is not worth indexing. Exported so the
 * SKILL.md coverage claim can be tested against the real sync scope: whatever
 * is listed here is NOT searchable from the room.
 */
export const SKIP_FOLDERS = new Set(["junkemail", "deleteditems", "drafts"]);

const FOLDERS: Array<[string, string]> = [
  ["INBOX", "inbox"],
  ["Sent", "sentitems"],
];

export const LOGIN_HINT =
  "a sign-in link is published in `mail status` (auth_urls); `mail login` re-opens the browser";

export class GraphHTTPError extends Error {
  constructor(
    readonly status: number,
    method: string,
    url: string,
    body: string,
  ) {
    super(`graph ${method} ${url} -> ${status}: ${body.slice(0, 500)}`);
  }
}

export type RequestFn = (
  method: string,
  url: string,
  token: string,
  opts?: {
    data?: Buffer;
    contentType?: string;
    headers?: Record<string, string>;
  },
) => Promise<{ status: number; body: Buffer }>;

async function fetchOnce(
  method: string,
  url: string,
  token: string,
  opts: {
    data?: Buffer;
    contentType?: string;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(opts.headers ?? {}),
  };
  if (opts.data !== undefined) {
    headers["Content-Type"] = opts.contentType ?? "application/json";
  }
  return fetch(url, {
    method,
    headers,
    body: opts.data,
    signal: AbortSignal.timeout(60_000),
  });
}

export const defaultRequestFn: RequestFn = async (
  method,
  url,
  token,
  opts = {},
) => {
  let resp = await fetchOnce(method, url, token, opts);
  if (resp.status === 429) {
    // throttled: honor Retry-After once
    const wait = Math.min(
      Number(resp.headers.get("retry-after") || "5") || 5,
      60,
    );
    log.warn(`graph throttled; sleeping ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    resp = await fetchOnce(method, url, token, opts);
  }
  const body = Buffer.from(await resp.arrayBuffer());
  if (resp.status >= 400) {
    throw new GraphHTTPError(resp.status, method, url, body.toString("utf-8"));
  }
  return { status: resp.status, body };
};

// ---- auth ----------------------------------------------------------

function cachePath(layout: Layout): string {
  return `${layout.credentials}/msal_token_cache.json`;
}

function buildApp(layout: Layout, clientId: string): PublicClientApplication {
  const file = cachePath(layout);
  return new PublicClientApplication({
    auth: { clientId, authority: AUTHORITY },
    cache: {
      cachePlugin: {
        beforeCacheAccess: async (ctx) => {
          try {
            ctx.tokenCache.deserialize(fs.readFileSync(file, "utf-8"));
          } catch {
            /* first run */
          }
        },
        afterCacheAccess: async (ctx) => {
          if (ctx.cacheHasChanged) {
            fs.mkdirSync(layout.credentials, { recursive: true });
            fs.writeFileSync(file, ctx.tokenCache.serialize());
            if (process.platform !== "win32") fs.chmodSync(file, 0o600);
          }
        },
      },
    },
  });
}

async function cachedAccount(
  app: PublicClientApplication,
  address: string,
): Promise<AccountInfo | undefined> {
  const accounts = await app.getTokenCache().getAllAccounts();
  return accounts.find(
    (a) => a.username.toLowerCase() === address.toLowerCase(),
  );
}

/**
 * Local-only view of one Microsoft account's auth: 'unconfigured',
 * 'needs_login', or 'ok' (a cached account matches this address; the token
 * may still be refreshed on use). Safe to call on every cycle.
 */
export async function authState(
  layout: Layout,
  acct: AccountConfig,
): Promise<string> {
  if (!acct.client_id || !acct.address) return "unconfigured";
  try {
    const app = buildApp(layout, acct.client_id);
    return (await cachedAccount(app, acct.address)) ? "ok" : "needs_login";
  } catch {
    return "needs_login";
  }
}

/** Silent-only token acquisition; null when a human is needed. */
export async function acquireTokenSilentFor(
  layout: Layout,
  acct: AccountConfig,
): Promise<string | null> {
  if (!acct.client_id) return null;
  try {
    const app = buildApp(layout, acct.client_id);
    const account = await cachedAccount(app, acct.address);
    if (!account) return null;
    const result = await app.acquireTokenSilent({ account, scopes: SCOPES });
    return result?.accessToken ?? null;
  } catch (err) {
    log.warn(
      `microsoft: silent token refresh for ${acct.address} failed: ${err}`,
    );
    return null;
  }
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      const cleanUrl = url.replace(/"/g, '\\"');
      exec(`start "" "${cleanUrl}"`);
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (err) {
    log.warn(
      `could not open a browser (${err}); the sign-in URL is in mail status`,
    );
  }
}

interface PendingFlow {
  url: string;
  server: http.Server;
  timer: NodeJS.Timeout;
}

/**
 * Loopback sign-in flows, one per address. Runs inside the long-lived
 * server process; a flow never blocks a tool call — it resolves in the
 * background when the browser redirect lands.
 */
export class LoginManager {
  private pending = new Map<string, PendingFlow>();
  private lastOutcome = new Map<string, string>();
  /** addresses the broker already auto-triggered this process run */
  readonly autoAttempted = new Set<string>();
  /**
   * Cap on browser windows this process may open by itself: account/login
   * requests are agent-writable, and an injected instruction loop must not
   * be able to storm the user with popups. The sign-in URL always remains
   * available in `mail status`.
   */
  private autoOpensLeft = 5;

  pendingUrls(): Record<string, string> {
    return Object.fromEntries(
      [...this.pending].map(([addr, flow]) => [addr, flow.url]),
    );
  }

  outcome(address: string): string | undefined {
    return this.lastOutcome.get(address.toLowerCase());
  }

  /**
   * Start (or return the already-pending) sign-in flow for an account.
   * Returns the URL the user must open; also tries to open the browser
   * when `autoOpen` is set.
   */
  async ensureFlow(
    layout: Layout,
    acct: AccountConfig,
    opts: { autoOpen?: boolean } = {},
  ): Promise<string | null> {
    const address = acct.address.toLowerCase();
    if (!acct.client_id) return null;
    const existing = this.pending.get(address);
    if (existing) {
      if (opts.autoOpen) this.tryAutoOpen(existing.url);
      return existing.url;
    }

    const app = buildApp(layout, acct.client_id);
    const { verifier, challenge } =
      await new CryptoProvider().generatePkceCodes();
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://localhost:${port}`;

    const url = await app.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      loginHint: acct.address,
      prompt: "select_account",
    });

    const finish = (outcome: string) => {
      this.lastOutcome.set(address, outcome);
      const flow = this.pending.get(address);
      if (flow) {
        clearTimeout(flow.timer);
        flow.server.close();
        this.pending.delete(address);
      }
    };

    server.on("request", (req, res) => {
      void (async () => {
        const reqUrl = new URL(req.url ?? "/", redirectUri);
        const code = reqUrl.searchParams.get("code");
        const error = reqUrl.searchParams.get("error");
        if (!code) {
          if (error) {
            respond(res, `Sign-in failed: ${error}. You can close this tab.`);
            finish(`failed: ${error}`);
          } else {
            respond(
              res,
              "Message Operator is waiting for the Microsoft sign-in redirect.",
            );
          }
          return;
        }
        try {
          const result = await app.acquireTokenByCode({
            code,
            scopes: SCOPES,
            redirectUri,
            codeVerifier: verifier,
          });
          const got = result?.account?.username?.toLowerCase() ?? "";
          if (got && got !== address) {
            // wrong account picked in the browser: the token is cached under
            // its own username and will never match this address
            respond(
              res,
              `You signed in as ${got}, but messageoperator needs ${address}. ` +
                "Run `mail login` again and pick the right account.",
            );
            finish(`wrong_account: ${got}`);
            return;
          }
          respond(
            res,
            `Message Operator is signed in as ${address}. You can close this tab.`,
          );
          finish("ok");
          log.info(`microsoft: sign-in completed for ${address}`);
        } catch (err) {
          respond(res, `Sign-in failed: ${err}. Run \`mail login\` to retry.`);
          finish(`failed: ${err}`);
        }
      })();
    });

    const timer = setTimeout(() => {
      log.info(
        `microsoft: sign-in flow for ${address} timed out; closing listener`,
      );
      finish("timed_out");
    }, LOGIN_TIMEOUT_MS);
    timer.unref();

    this.pending.set(address, { url, server, timer });
    log.info(
      `microsoft: sign-in flow for ${address} listening on ${redirectUri}`,
    );
    if (opts.autoOpen) this.tryAutoOpen(url);
    return url;
  }

  private tryAutoOpen(url: string): void {
    if (this.autoOpensLeft <= 0) {
      log.warn(
        "auto-open budget exhausted for this session; the sign-in URL stays " +
          "available in mail status",
      );
      return;
    }
    this.autoOpensLeft -= 1;
    openBrowser(url);
  }

  closeAll(): void {
    for (const [address] of this.pending) {
      const flow = this.pending.get(address);
      if (flow) {
        clearTimeout(flow.timer);
        flow.server.close();
      }
    }
    this.pending.clear();
  }
}

function respond(res: http.ServerResponse, message: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>messageoperator</title>` +
      `<body style="font-family: system-ui; margin: 4em auto; max-width: 32em">` +
      `<p>${message}</p></body>`,
  );
}

// ---- sync ----------------------------------------------------------

export type TokenGetter = (acct: AccountConfig) => Promise<string | null>;

export interface GraphSyncOptions {
  requestFn?: RequestFn;
  getToken?: TokenGetter;
  /** absolute time (opts.now clock) the history backfill must yield by */
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
  opts: GraphSyncOptions = {},
): Promise<void> {
  const requestFn = opts.requestFn ?? defaultRequestFn;
  const getToken =
    opts.getToken ??
    ((acct: AccountConfig) => acquireTokenSilentFor(layout, acct));
  for (const acct of accountsFor(cfg, "microsoft")) {
    if (!acct.client_id) continue;
    const token = await getToken(acct);
    if (token === null) {
      log.info(
        `microsoft: no token for ${acct.address} (${LOGIN_HINT}); skipping sync`,
      );
      continue;
    }
    layout.ensureAccount(acct.address);
    for (const [local, remote] of FOLDERS) {
      try {
        await syncFolder(
          layout,
          index,
          ledger,
          token,
          acct.address,
          local,
          remote,
          explained,
          requestFn,
        );
      } catch (err) {
        log.error(
          `microsoft: sync of ${remote} for ${acct.address} failed: ${err}`,
        );
      }
    }
    // whole-mailbox history as metadata rows, strictly time-boxed
    try {
      await backfillHistory(index, ledger, token, acct.address, requestFn, {
        deadline:
          opts.historyDeadline ??
          (opts.now ?? Date.now)() + DEFAULT_BACKFILL_BUDGET_MS,
        now: opts.now ?? Date.now,
      });
    } catch (err) {
      log.error(
        `microsoft: history backfill for ${acct.address} failed: ${err}`,
      );
    }
  }
}

/**
 * Resolve well-known folder ids to names, once per account (folder ids are
 * immutable per mailbox, so the map caches forever in kv state).
 */
async function resolveFolderMap(
  index: Index,
  token: string,
  address: string,
  requestFn: RequestFn,
): Promise<Record<string, string>> {
  const key = `graph:${address}:folders`;
  const cached = index.getState(key);
  if (cached) {
    try {
      return JSON.parse(cached) as Record<string, string>;
    } catch {
      /* re-resolve */
    }
  }
  const map: Record<string, string> = {};
  const names = [
    "inbox",
    "sentitems",
    "archive",
    "drafts",
    "junkemail",
    "deleteditems",
  ];
  for (const name of names) {
    try {
      const { body } = await requestFn(
        "GET",
        `${GRAPH}/me/mailFolders/${name}?$select=id`,
        token,
      );
      const id = (JSON.parse(body.toString("utf-8")) as { id?: string }).id;
      if (id) map[id] = name;
    } catch {
      /* the folder may not exist (e.g. archive never provisioned) */
    }
  }
  index.setState(key, JSON.stringify(map));
  return map;
}

function historyStartUrl(): string {
  const params = new URLSearchParams({
    $select:
      "id,receivedDateTime,subject,from,toRecipients,internetMessageId,parentFolderId",
    $orderby: "receivedDateTime desc",
    $top: String(HISTORY_PAGE),
  });
  return `${GRAPH}/me/messages?${params}`;
}

interface HistoryItem {
  id?: string;
  receivedDateTime?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  internetMessageId?: string;
  parentFolderId?: string;
}

/** Insert one history listing as a metadata-only row. false = dup/skip. */
function indexHistoryItem(
  index: Index,
  address: string,
  item: HistoryItem,
  folders: Record<string, string>,
): boolean {
  const id = String(item.id ?? "");
  if (!id) return false;
  const knownFolder = folders[String(item.parentFolderId ?? "")] ?? "";
  const knownLocal =
    knownFolder === "inbox"
      ? "INBOX"
      : knownFolder === "sentitems"
        ? "Sent"
        : "Archive";
  // Already indexed: not a new row, but parentFolderId is FRESH from Graph, so
  // this is where a message moved outside Message Operator (Outlook, a rule, a phone)
  // gets noticed. Without it the row keeps its original folder forever.
  if (
    index.graphIsSeen(id) ||
    index.hasSha(`ms:${id}`) ||
    index.hasProviderMsg(address, id)
  ) {
    if (knownFolder && !SKIP_FOLDERS.has(knownFolder)) {
      index.reconcileFolder(address, id, knownLocal);
    }
    return false;
  }
  const sha = `ms:${id}`;
  const rfcId = item.internetMessageId
    ? String(item.internetMessageId)
    : undefined;
  if (rfcId && index.hasRfcMessageId(address, rfcId)) return false;
  if (SKIP_FOLDERS.has(knownFolder)) return false;
  const folder = knownLocal;
  const labels =
    knownFolder === "inbox"
      ? ["INBOX"]
      : knownFolder === "sentitems"
        ? ["SENT"]
        : [];
  const from = item.from?.emailAddress;
  const fromText = from?.address
    ? from.name
      ? `${from.name} <${from.address}>`
      : from.address
    : "";
  const toText = (item.toRecipients ?? [])
    .map((r) => r?.emailAddress?.address ?? "")
    .filter(Boolean)
    .join(", ");
  const received = item.receivedDateTime
    ? new Date(item.receivedDateTime)
    : null;
  index.insertMessage({
    sha,
    account: address,
    folder,
    filename: "",
    path: "",
    date: received ? received.toUTCString() : "",
    epoch: received ? Math.floor(received.getTime() / 1000) : 0,
    from: fromText,
    to: toText,
    subject: item.subject ?? "",
    body: "",
    labels,
    gmailId: id,
    rfcMessageId: rfcId,
    metaOnly: true,
  });
  return true;
}

/**
 * Historical backfill: one descending receivedDateTime walk over
 * /me/messages, metadata-only, resumable via the stored nextLink cursor and
 * strictly time-boxed by `budget.deadline` so a 100k-message mailbox grows
 * the index across many cycles without stretching any single tool call.
 */
async function backfillHistory(
  index: Index,
  ledger: Ledger,
  token: string,
  address: string,
  requestFn: RequestFn,
  budget: { deadline: number; now: () => number },
): Promise<void> {
  let state = index.getSyncState(address, HISTORY_MAILBOX);
  if (state?.status === "caught_up") return;
  const folders = await resolveFolderMap(index, token, address, requestFn);
  if (!state) {
    state = {
      account: address,
      mailbox: HISTORY_MAILBOX,
      uidValidity: null,
      lastUid: 0,
      lowUid: 0,
      cursor: null,
      status: "in_progress",
      totalExpected: null,
    };
    index.putSyncState(state);
  }

  let url: string | null = state.cursor || historyStartUrl();
  let indexed = 0;
  while (url && budget.now() < budget.deadline) {
    let page: { value?: HistoryItem[]; "@odata.nextLink"?: string };
    try {
      const { body } = await requestFn("GET", url, token);
      page = JSON.parse(body.toString("utf-8"));
    } catch (err) {
      if (err instanceof GraphHTTPError && state.cursor) {
        // stored skiptoken rejected (expired): restart the walk next cycle;
        // dedup by graph id keeps the re-walk idempotent
        log.warn(
          `microsoft: history cursor for ${address} rejected (${err.status}); restarting`,
        );
        state.cursor = null;
        index.putSyncState(state);
        return;
      }
      throw err;
    }
    const items = page.value ?? [];
    const next = page["@odata.nextLink"] ?? null;
    // one commit per page, rows atomic with the cursor that covers them
    indexed += index.transaction(() => {
      let count = 0;
      for (const item of items) {
        if (indexHistoryItem(index, address, item, folders)) count += 1;
      }
      state.cursor = next;
      if (!next) state.status = "caught_up";
      index.putSyncState(state);
      return count;
    });
    url = next;
  }

  if (indexed) {
    log.info(
      `microsoft: indexed ${indexed} history messages (metadata) for ${address}; ` +
        `backfill ${state.status === "caught_up" ? "caught up" : "continues next cycle"}`,
    );
    ledger.append("sync_archive_meta", {
      account: address,
      count: indexed,
      backfill: state.status,
    });
  }
}

function deltaStateKey(address: string, remote: string): string {
  return `graph:${address}:${remote}:delta`;
}

function initialDeltaUrl(remote: string): string {
  const since = new Date(Date.now() - FAST_SYNC_DAYS * 86400_000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const params = new URLSearchParams({
    $select: "id,receivedDateTime",
    $filter: `receivedDateTime ge ${since}`,
  });
  return `${GRAPH}/me/mailFolders/${remote}/messages/delta?${params}`;
}

/**
 * Follow a delta feed to its end. Returns new (id, receivedDateTime) pairs
 * and the next deltaLink. Throws GraphHTTPError — including 410 — upward.
 */
async function walkDelta(
  index: Index,
  ledger: Ledger,
  token: string,
  address: string,
  local: string,
  startUrl: string,
  requestFn: RequestFn,
): Promise<[Array<[string, string]>, string | null]> {
  const newItems: Array<[string, string]> = [];
  let url: string | null = startUrl;
  let deltaLink: string | null = null;
  // delta ignores $top; page size is set via the Prefer header instead
  const headers = { Prefer: `odata.maxpagesize=${PAGE_SIZE}` };
  while (url) {
    const { body } = await requestFn("GET", url, token, { headers });
    const page = JSON.parse(body.toString("utf-8"));
    for (const item of page.value ?? []) {
      if (Object.keys(item).some((k) => k.startsWith("@removed"))) {
        // deleted/moved on the server; keep the local copy (the room only
        // grows) but leave an audit trail
        ledger.append("remote_removed", {
          account: address,
          folder: local,
          graph_id: item.id,
        });
        // This is the ONLY place Graph tells us a message left the inbox, so it
        // is where "archived in Outlook / on a phone / by a rule" has to be
        // acted on. The history backfill cannot do it: it sweeps each message
        // once and never revisits an already-indexed one.
        //
        // Archive is the room's bucket for "no longer in the inbox but still
        // kept", and the room never deletes — so a removal for any reason
        // (archived, moved, deleted) is most truthfully filed there. Leaving it
        // in INBOX is the one answer that is definitely wrong. Restricted to the
        // INBOX delta: a removal from Sent means something else entirely.
        if (local === "INBOX" && item.id) {
          index.reconcileFolder(address, String(item.id), "Archive");
        }
        continue;
      }
      const graphId = item.id;
      if (graphId && !index.graphIsSeen(graphId)) {
        newItems.push([graphId, String(item.receivedDateTime ?? "")]);
      }
    }
    url = page["@odata.nextLink"] ?? null;
    if (!url) deltaLink = page["@odata.deltaLink"] ?? null;
  }
  return [newItems, deltaLink];
}

async function syncFolder(
  layout: Layout,
  index: Index,
  ledger: Ledger,
  token: string,
  address: string,
  local: string,
  remote: string,
  explained: Set<string>,
  requestFn: RequestFn,
): Promise<void> {
  const stateKey = deltaStateKey(address, remote);
  const storedLink = index.getState(stateKey);

  let newItems: Array<[string, string]>;
  let deltaLink: string | null;
  if (storedLink) {
    try {
      [newItems, deltaLink] = await walkDelta(
        index,
        ledger,
        token,
        address,
        local,
        storedLink,
        requestFn,
      );
    } catch (err) {
      if (!(err instanceof GraphHTTPError) || err.status !== 410) throw err;
      // delta token expired (resyncRequired): full walk re-establishes the
      // baseline; sha dedup in storeMessage makes re-listing safe
      log.info(`microsoft: delta link for ${remote} expired; resyncing`);
      index.setState(stateKey, "");
      [newItems, deltaLink] = await walkDelta(
        index,
        ledger,
        token,
        address,
        local,
        initialDeltaUrl(remote),
        requestFn,
      );
    }
  } else {
    [newItems, deltaLink] = await walkDelta(
      index,
      ledger,
      token,
      address,
      local,
      initialDeltaUrl(remote),
      requestFn,
    );
  }

  // newest first; cap what we download but never silently: skipped ids are
  // marked seen and logged
  newItems.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  const toFetch = newItems.slice(0, MAX_PER_FOLDER);
  const skipped = newItems.slice(MAX_PER_FOLDER);

  let storedCount = 0;
  for (const [graphId] of toFetch) {
    const quoted = encodeURIComponent(graphId);
    const { body } = await requestFn(
      "GET",
      `${GRAPH}/me/messages/${quoted}/$value`,
      token,
    );
    await storeMessage(layout, index, ledger, {
      account: address,
      folder: local,
      raw: body,
      explained,
      providerMsgId: graphId,
      labels: [local === "INBOX" ? "INBOX" : "SENT"],
    });
    index.graphMarkSeen(graphId, address);
    storedCount += 1;
  }
  for (const [graphId] of skipped) {
    // no message row is written for these, so `address` is the ONLY thing that
    // ties the id to a mailbox — without it, removing the account leaves the id
    // behind and a re-add skips these messages forever
    index.graphMarkSeen(graphId, address);
  }
  if (skipped.length) {
    log.warn(
      `microsoft: ${remote} capped at ${MAX_PER_FOLDER} messages; ` +
        `${skipped.length} older messages skipped`,
    );
  }
  if (deltaLink) index.setState(stateKey, deltaLink);
  if (storedCount) {
    log.info(
      `microsoft: stored ${storedCount} new messages from ${remote} (${address})`,
    );
  }
}

/**
 * Download one raw MIME body by Graph message id, for a metadata-only row.
 * Throws Rejection when the account is not authenticated; GraphHTTPError
 * (e.g. 404 for a deleted message) propagates to the caller.
 */
export async function fetchBody(
  layout: Layout,
  acct: AccountConfig,
  graphId: string,
  opts: { requestFn?: RequestFn; getToken?: TokenGetter } = {},
): Promise<Buffer> {
  const requestFn = opts.requestFn ?? defaultRequestFn;
  const getToken =
    opts.getToken ?? ((a: AccountConfig) => acquireTokenSilentFor(layout, a));
  const token = await getToken(acct);
  if (token === null) {
    throw new Rejection(
      "needs_auth",
      `microsoft account ${acct.address} is not authenticated; ${LOGIN_HINT}`,
    );
  }
  const { body } = await requestFn(
    "GET",
    `${GRAPH}/me/messages/${encodeURIComponent(graphId)}/$value`,
    token,
  );
  return body;
}

/**
 * One cheap Graph call proving the token actually grants mailbox access.
 * Used by `messageoperator login` so a bad app registration fails at sign-in time.
 */
export async function verifyMailbox(
  token: string,
  requestFn: RequestFn = defaultRequestFn,
): Promise<{ displayName?: string; totalItemCount?: number }> {
  const { body } = await requestFn(
    "GET",
    `${GRAPH}/me/mailFolders/inbox?$select=displayName,totalItemCount`,
    token,
  );
  return JSON.parse(body.toString("utf-8"));
}

/** Deliver a raw MIME message via Graph sendMail. */
export async function sendMime(
  layout: Layout,
  acct: AccountConfig,
  mime: Buffer,
  opts: { requestFn?: RequestFn; getToken?: TokenGetter } = {},
): Promise<void> {
  const requestFn = opts.requestFn ?? defaultRequestFn;
  const getToken =
    opts.getToken ?? ((a: AccountConfig) => acquireTokenSilentFor(layout, a));
  const token = await getToken(acct);
  if (token === null) {
    throw new Rejection(
      "delivery_unavailable",
      `microsoft account ${acct.address} is not authenticated; ${LOGIN_HINT}`,
    );
  }
  const { status } = await requestFn("POST", `${GRAPH}/me/sendMail`, token, {
    data: Buffer.from(mime.toString("base64")),
    contentType: "text/plain",
  });
  if (status !== 200 && status !== 202) {
    throw new Error(`graph sendMail returned ${status}`);
  }
}

// ---- folder changes (archive / move) --------------------------------
//
// The provider-abstracted folder-change primitive, Graph side. Outlook has
// true hierarchical folders, so both archive and move reduce to one POST
// /messages/{id}/move — archive targets the `archive` well-known folder,
// unarchive targets `inbox`, and phase 2's `mail move` will pass a resolved
// mailFolder id. Identified by internetMessageId (the RFC Message-ID), so
// nothing is stored at sync time. NEVER destructive: no DELETE, no
// deleteditems, no permanentDelete — only /move.

export async function moveMessage(
  layout: Layout,
  acct: AccountConfig,
  move: { internetMessageId: string; target: string },
  opts: {
    requestFn?: RequestFn;
    getToken?: (acct: AccountConfig) => Promise<string | null>;
  } = {},
): Promise<"applied" | "noop"> {
  const requestFn = opts.requestFn ?? defaultRequestFn;
  const getToken =
    opts.getToken ?? ((a: AccountConfig) => acquireTokenSilentFor(layout, a));
  const token = await getToken(acct);
  if (token === null) {
    throw new Rejection(
      "needs_auth",
      `microsoft account ${acct.address} is not authenticated; ${LOGIN_HINT}`,
    );
  }

  // OData string literal: single quotes double
  const literal = move.internetMessageId.replace(/'/g, "''");
  const found = await requestFn(
    "GET",
    `${GRAPH}/me/messages?$filter=internetMessageId eq '${encodeURIComponent(literal)}'` +
      `&$select=id,parentFolderId`,
    token,
  );
  const value = (JSON.parse(found.body.toString("utf-8")).value ??
    []) as Array<{
    id: string;
    parentFolderId: string;
  }>;
  const message = value[0];
  if (!message) {
    throw new Rejection(
      "message_not_found",
      `no message with internetMessageId ${move.internetMessageId} found in ${acct.address}`,
    );
  }

  let targetId: string;
  try {
    const folder = await requestFn(
      "GET",
      `${GRAPH}/me/mailFolders/${move.target}?$select=id`,
      token,
    );
    targetId = String(JSON.parse(folder.body.toString("utf-8")).id ?? "");
  } catch (err) {
    throw new Rejection(
      "target_not_found",
      `mail folder ${move.target}: ${err}`,
    );
  }
  if (!targetId) {
    throw new Rejection(
      "target_not_found",
      `mail folder ${move.target} has no id`,
    );
  }

  if (message.parentFolderId === targetId) return "noop"; // already there

  const moved = await requestFn(
    "POST",
    `${GRAPH}/me/messages/${message.id}/move`,
    token,
    { data: Buffer.from(JSON.stringify({ destinationId: targetId })) },
  );
  if (moved.status !== 200 && moved.status !== 201) {
    throw new Error(`graph move returned ${moved.status}`);
  }
  return "applied";
}

// ---- provider drafts (upload / delete) -------------------------------
//
// The provider-abstracted draft primitive, Graph side. A draft is created by
// POSTing the raw MIME to /me/messages (base64, text/plain) — Graph files it
// as an unsent message in the Drafts folder, reviewable and sendable from any
// Outlook client. Deleting a draft is a reversible /move to the well-known
// `deleteditems` folder, scoped to the Drafts folder and identified by the
// draft's internetMessageId. NEVER a DELETE / permanentDelete, matching the
// non-destructive invariant of moveMessage above. Recoverable from Deleted
// Items until Outlook's own retention removes it.

/**
 * Create an unsent draft from raw MIME via Graph. Returns the new message's
 * Graph id and internetMessageId (the RFC Message-ID) when the server reports
 * them, so the caller can record/track the draft.
 */
export async function uploadDraft(
  layout: Layout,
  acct: AccountConfig,
  mime: Buffer,
  opts: { requestFn?: RequestFn; getToken?: TokenGetter } = {},
): Promise<{ id?: string; internetMessageId?: string }> {
  const requestFn = opts.requestFn ?? defaultRequestFn;
  const getToken =
    opts.getToken ?? ((a: AccountConfig) => acquireTokenSilentFor(layout, a));
  const token = await getToken(acct);
  if (token === null) {
    throw new Rejection(
      "needs_auth",
      `microsoft account ${acct.address} is not authenticated; ${LOGIN_HINT}`,
    );
  }
  const { status, body } = await requestFn(
    "POST",
    `${GRAPH}/me/messages`,
    token,
    {
      data: Buffer.from(mime.toString("base64")),
      contentType: "text/plain",
    },
  );
  if (status !== 200 && status !== 201) {
    throw new Rejection(
      "draft_upload_failed",
      `graph draft create returned ${status}`,
    );
  }
  const created = JSON.parse(body.toString("utf-8")) as {
    id?: string;
    internetMessageId?: string;
  };
  return { id: created.id, internetMessageId: created.internetMessageId };
}

/**
 * Reversibly delete an Outlook draft: find it in the Drafts folder by
 * internetMessageId and /move it to `deleteditems`. Returns "applied" when
 * moved, "noop" when no such draft exists. Never permanently deletes.
 */
export async function deleteDraft(
  layout: Layout,
  acct: AccountConfig,
  internetMessageId: string,
  opts: { requestFn?: RequestFn; getToken?: TokenGetter } = {},
): Promise<"applied" | "noop"> {
  const requestFn = opts.requestFn ?? defaultRequestFn;
  const getToken =
    opts.getToken ?? ((a: AccountConfig) => acquireTokenSilentFor(layout, a));
  const token = await getToken(acct);
  if (token === null) {
    throw new Rejection(
      "needs_auth",
      `microsoft account ${acct.address} is not authenticated; ${LOGIN_HINT}`,
    );
  }

  // OData string literal: single quotes double. Scope the search to Drafts so
  // a colliding Message-ID on a real message can never be trashed.
  const literal = internetMessageId.replace(/'/g, "''");
  const found = await requestFn(
    "GET",
    `${GRAPH}/me/mailFolders/drafts/messages` +
      `?$filter=internetMessageId eq '${encodeURIComponent(literal)}'&$select=id`,
    token,
  );
  const value = (JSON.parse(found.body.toString("utf-8")).value ??
    []) as Array<{ id: string }>;
  const draft = value[0];
  if (!draft) return "noop";

  const moved = await requestFn(
    "POST",
    `${GRAPH}/me/messages/${draft.id}/move`,
    token,
    { data: Buffer.from(JSON.stringify({ destinationId: "deleteditems" })) },
  );
  if (moved.status !== 200 && moved.status !== 201) {
    throw new Error(`graph move-to-deleteditems returned ${moved.status}`);
  }
  return "applied";
}
