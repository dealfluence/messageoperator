/**
 * Broker configuration (broker/config.json) with the multi-account schema:
 * a provider-tagged list instead of the Python POC's one-table-per-provider.
 *
 * Two sources merge:
 *  - broker/config.json — the durable file (accounts list, policy)
 *  - environment — what Claude Desktop injects from MCPB user_config
 *    (MESSAGEOPERATOR_GMAIL_ADDRESS, MESSAGEOPERATOR_MS_ADDRESS, MESSAGEOPERATOR_MS_CLIENT_ID,
 *    MESSAGEOPERATOR_DRY_RUN, MESSAGEOPERATOR_ALLOWED_RECIPIENT_DOMAINS). Env-declared
 *    accounts are appended if the file does not already list them, and
 *    env dry_run and MS client_id win while set: the extension settings
 *    pane is the primary UI on the macOS target. The file keeps the last
 *    persisted values so accounts survive a cleared pane or a reinstall.
 */

import fs from "node:fs";
import path from "node:path";

export type Provider = "gmail" | "microsoft";

export interface AccountConfig {
  provider: Provider;
  address: string;
  /** Azure app registration (public client); microsoft only. */
  client_id?: string;
}

export interface PolicyConfig {
  allowed_recipient_domains: string[];
  max_sends_per_hour: number;
  max_attachment_mb: number;
}

export interface Config {
  dry_run: boolean;
  serve_broker: "boundary" | "off";
  pull_interval_seconds: number;
  /** quota for on-demand-fetched inbound bodies (the .Cache maildirs) */
  body_cache_mb: number;
  accounts: AccountConfig[];
  policy: PolicyConfig;
}

export const DEFAULT_CONFIG: Config = {
  dry_run: true,
  serve_broker: "boundary",
  pull_interval_seconds: 30,
  body_cache_mb: 50,
  accounts: [],
  policy: {
    allowed_recipient_domains: [],
    max_sends_per_hour: 5,
    max_attachment_mb: 10,
  },
};

const README_LINES = [
  "Message Operator broker configuration.",
  "dry_run=true: everything except the network send happens (ledger: send_simulated).",
  "accounts: [{provider: 'gmail'|'microsoft', address, client_id?}] — any number per provider.",
  "Values injected by Claude Desktop (extension settings) are merged in and win for dry_run.",
  "policy.allowed_recipient_domains: [] means only your own account addresses may receive mail.",
];

export function ensureDefaultConfig(configPath: string): void {
  if (fs.existsSync(configPath)) return;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const body = { _readme: README_LINES, ...DEFAULT_CONFIG };
  fs.writeFileSync(configPath, JSON.stringify(body, null, 2) + "\n");
}

/**
 * Strict shape check for account addresses. Deliberately narrower than RFC
 * 5321: the address becomes a DIRECTORY NAME under room/accounts/, so it
 * must be incapable of path traversal or separator tricks — this guards the
 * agent-writable `mail account add` path.
 */
export function isValidAccountAddress(address: string): boolean {
  if (address.length > 254) return false;
  if (address.includes("..")) return false;
  return /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9_%+-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
    address,
  );
}

function parseAccounts(raw: unknown): AccountConfig[] {
  if (!Array.isArray(raw)) return [];
  const accounts: AccountConfig[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const provider = String(rec.provider || "").toLowerCase();
    const address = String(rec.address || "")
      .trim()
      .toLowerCase();
    if (
      (provider !== "gmail" && provider !== "microsoft") ||
      !isValidAccountAddress(address)
    ) {
      continue;
    }
    if (accounts.some((a) => a.address === address)) continue; // address is the key
    accounts.push({
      provider: provider as Provider,
      address,
      client_id: String(rec.client_id || "").trim() || undefined,
    });
  }
  return accounts;
}

/**
 * A user_config-fed env value, or undefined when it is unset, empty, or an
 * unresolved "${...}" template passed through literally by the host.
 */
export function cleanEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const raw = (env[name] ?? "").trim();
  if (!raw || raw.includes("${")) return undefined;
  return raw;
}

function envBool(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = cleanEnvValue(env, name);
  if (raw === undefined) return undefined;
  return !["false", "0", "no", "off"].includes(raw.toLowerCase());
}

function mergeEnv(cfg: Config, env: NodeJS.ProcessEnv): Config {
  // env addresses face the same shape check as every other source: they
  // become directory names, and a settings-pane typo must not wedge cycles
  const gmailAddr = (
    cleanEnvValue(env, "MESSAGEOPERATOR_GMAIL_ADDRESS") ?? ""
  ).toLowerCase();
  if (
    isValidAccountAddress(gmailAddr) &&
    !cfg.accounts.some((a) => a.address === gmailAddr)
  ) {
    cfg.accounts.push({ provider: "gmail", address: gmailAddr });
  }
  const msAddr = (
    cleanEnvValue(env, "MESSAGEOPERATOR_MS_ADDRESS") ?? ""
  ).toLowerCase();
  const msClient = cleanEnvValue(env, "MESSAGEOPERATOR_MS_CLIENT_ID") ?? "";
  if (isValidAccountAddress(msAddr)) {
    const existing = cfg.accounts.find((a) => a.address === msAddr);
    if (!existing) {
      cfg.accounts.push({
        provider: "microsoft",
        address: msAddr,
        client_id: msClient || undefined,
      });
    } else if (msClient) {
      // the extension pane is authoritative while set: a client_id edited
      // there must replace the one persisted in config.json (which is only
      // a snapshot so accounts survive a cleared pane / reinstall)
      existing.client_id = msClient;
    }
  } else if (msClient) {
    // client_id set without its own address: one app registration serves
    // all microsoft accounts, so the pane value applies to every one —
    // including accounts persisted with a now-stale client_id
    for (const acct of cfg.accounts) {
      if (acct.provider === "microsoft") acct.client_id = msClient;
    }
  }
  const dryRun = envBool(env, "MESSAGEOPERATOR_DRY_RUN");
  if (dryRun !== undefined) cfg.dry_run = dryRun;
  const domains =
    cleanEnvValue(env, "MESSAGEOPERATOR_ALLOWED_RECIPIENT_DOMAINS") ?? "";
  if (domains) {
    for (const d of domains.split(",")) {
      const domain = d.trim().toLowerCase().replace(/^@/, "");
      if (domain && !cfg.policy.allowed_recipient_domains.includes(domain)) {
        cfg.policy.allowed_recipient_domains.push(domain);
      }
    }
  }
  return cfg;
}

/** broker/config.json parsed as an object, or {} when unreadable/not an object. */
function readJsonRecord(configPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Persist a newly registered account into broker/config.json (the durable
 * file — not the merged view). Used when `mail login <new-address>` brings
 * a mailbox aboard at runtime. Returns false when the address is already
 * listed. Preserves every other key in the file (_readme, policy, ...).
 */
export function appendAccountToFile(
  configPath: string,
  account: AccountConfig,
): boolean {
  const data = readJsonRecord(configPath);
  const accounts: Array<Record<string, unknown>> = Array.isArray(data.accounts)
    ? data.accounts
    : [];
  const address = account.address.trim().toLowerCase();
  if (
    accounts.some((a) => String(a?.address ?? "").toLowerCase() === address)
  ) {
    return false;
  }
  accounts.push({
    provider: account.provider,
    address,
    ...(account.client_id ? { client_id: account.client_id } : {}),
  });
  data.accounts = accounts;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
  return true;
}

export function loadConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const data = readJsonRecord(configPath);
  const serveBroker = String(data.serve_broker ?? "")
    .trim()
    .toLowerCase();
  let pullInterval = Number(data.pull_interval_seconds);
  if (!Number.isFinite(pullInterval) || pullInterval < 0) pullInterval = 30;
  let bodyCacheMb = Number(data.body_cache_mb);
  if (!Number.isFinite(bodyCacheMb) || bodyCacheMb < 0) {
    bodyCacheMb = DEFAULT_CONFIG.body_cache_mb;
  }
  const policy =
    typeof data.policy === "object" && data.policy !== null
      ? (data.policy as Record<string, unknown>)
      : {};
  const cfg: Config = {
    dry_run: data.dry_run === undefined ? true : Boolean(data.dry_run),
    serve_broker: serveBroker === "off" ? "off" : "boundary",
    pull_interval_seconds: Math.floor(pullInterval),
    body_cache_mb: bodyCacheMb,
    accounts: parseAccounts(data.accounts),
    policy: {
      allowed_recipient_domains: Array.isArray(policy.allowed_recipient_domains)
        ? policy.allowed_recipient_domains.map((d: unknown) =>
            String(d).toLowerCase().replace(/^@/, ""),
          )
        : [],
      max_sends_per_hour: Number.isFinite(Number(policy.max_sends_per_hour))
        ? Number(policy.max_sends_per_hour)
        : 5,
      max_attachment_mb: Number.isFinite(Number(policy.max_attachment_mb))
        ? Number(policy.max_attachment_mb)
        : 10,
    },
  };
  const merged = mergeEnv(cfg, env);
  return applySettingsPage(merged, data);
}

/**
 * Values saved from the local settings page live in a dedicated
 * `settings_page` section and are applied LAST — after the extension
 * settings' env injection — so a choice made on the page survives extension
 * restarts and reinstalls. The extension pane remains the bootstrap default
 * for anything the page has never touched.
 */
function applySettingsPage(cfg: Config, data: Record<string, unknown>): Config {
  const section =
    typeof data.settings_page === "object" && data.settings_page !== null
      ? (data.settings_page as Record<string, unknown>)
      : null;
  if (!section) return cfg;
  if (typeof section.dry_run === "boolean") cfg.dry_run = section.dry_run;
  if (Array.isArray(section.allowed_recipient_domains)) {
    cfg.policy.allowed_recipient_domains = section.allowed_recipient_domains
      .map((d: unknown) => String(d).toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
  }
  return cfg;
}

/** Which surface currently decides dry_run (for honest display on the page). */
export function dryRunSource(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): "settings_page" | "extension_settings" | "config_file" | "default" {
  const data = readJsonRecord(configPath);
  const section = data.settings_page as Record<string, unknown> | undefined;
  if (section && typeof section.dry_run === "boolean") return "settings_page";
  if (envBool(env, "MESSAGEOPERATOR_DRY_RUN") !== undefined)
    return "extension_settings";
  if (data.dry_run !== undefined) return "config_file";
  return "default";
}

/** Persist choices made on the local settings page (they win from then on). */
export function saveSettingsPage(
  configPath: string,
  values: { dry_run?: boolean; allowed_recipient_domains?: string[] },
): void {
  const data = readJsonRecord(configPath);
  const section =
    typeof data.settings_page === "object" && data.settings_page !== null
      ? (data.settings_page as Record<string, unknown>)
      : {};
  if (values.dry_run !== undefined) section.dry_run = values.dry_run;
  if (values.allowed_recipient_domains !== undefined) {
    section.allowed_recipient_domains = values.allowed_recipient_domains
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
  }
  data.settings_page = section;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
}

/** Drop an account from the durable file; true if it was present. */
export function removeAccountFromFile(
  configPath: string,
  address: string,
): boolean {
  const data = readJsonRecord(configPath);
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const lower = address.trim().toLowerCase();
  const kept = accounts.filter(
    (a: unknown) =>
      String((a as { address?: string })?.address ?? "").toLowerCase() !==
      lower,
  );
  if (kept.length === accounts.length) return false;
  data.accounts = kept;
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
  return true;
}

/**
 * Append an account to broker/config.json (the durable file, not the merged
 * view). Returns false when the address is already present. This is how
 * agent-initiated setup lands: the in-room `mail account add` writes a
 * request file, the broker validates it and persists here — addresses and
 * providers only, never credentials.
 */
export function persistAccount(
  configPath: string,
  account: AccountConfig,
): boolean {
  const data = readJsonRecord(configPath);
  const accounts: Array<Record<string, unknown>> = Array.isArray(data.accounts)
    ? data.accounts
    : [];
  const address = account.address.trim().toLowerCase();
  if (!isValidAccountAddress(address)) return false;
  const exists = accounts.some(
    (a) =>
      String(a?.address ?? "")
        .trim()
        .toLowerCase() === address,
  );
  if (exists) return false;
  const entry: Record<string, string> = { provider: account.provider, address };
  if (account.client_id) entry.client_id = account.client_id;
  accounts.push(entry);
  data.accounts = accounts;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = configPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, configPath);
  return true;
}

/**
 * A client id reduced to a recognizable suffix for logs, status, and
 * notices. An Azure app (client) id is not a secret, but full ids make
 * every message unreadable; six characters are enough to tell two apart.
 */
export function maskClientId(id: string | undefined): string {
  const value = (id ?? "").trim();
  if (!value) return "(not set)";
  return "…" + value.slice(-6);
}

/**
 * address -> the Microsoft app (client) id actually in effect (masked) and
 * which surface supplied it. Published in the status file so a user who just
 * changed the id in the extension settings can verify the change landed —
 * env is injected at spawn, so a pane edit needs a host restart to arrive.
 */
export function msClientIdSummary(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): Record<
  string,
  { suffix: string; source: "extension_settings" | "config_file" }
> {
  const fromEnv = cleanEnvValue(env, "MESSAGEOPERATOR_MS_CLIENT_ID");
  const out: Record<
    string,
    { suffix: string; source: "extension_settings" | "config_file" }
  > = {};
  for (const acct of accountsFor(cfg, "microsoft")) {
    if (!acct.client_id) continue;
    out[acct.address] = {
      suffix: maskClientId(acct.client_id),
      source: fromEnv === acct.client_id ? "extension_settings" : "config_file",
    };
  }
  return out;
}

/**
 * The client_id to use for a Microsoft account that arrives without one:
 * the extension-settings value, or the one shared by every already
 * configured Microsoft account. One Azure app registration serves all
 * accounts, so this is normally unambiguous.
 */
export function defaultMsClientId(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = cleanEnvValue(env, "MESSAGEOPERATOR_MS_CLIENT_ID");
  if (fromEnv) return fromEnv;
  const ids = new Set(
    accountsFor(cfg, "microsoft")
      .map((a) => a.client_id)
      .filter((id): id is string => !!id),
  );
  return ids.size === 1 ? [...ids][0] : undefined;
}

export function ownAddresses(cfg: Config): Set<string> {
  return new Set(cfg.accounts.map((a) => a.address.toLowerCase()));
}

export function accountsFor(cfg: Config, provider: Provider): AccountConfig[] {
  return cfg.accounts.filter((a) => a.provider === provider);
}

export function findAccount(
  cfg: Config,
  address: string,
): AccountConfig | undefined {
  const lower = address.toLowerCase();
  return cfg.accounts.find((a) => a.address === lower);
}
