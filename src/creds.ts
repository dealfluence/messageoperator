/**
 * Credential resolution for the broker — multi-account edition.
 *
 * Gmail app passwords live one file per address under broker/credentials/
 * (gmail_app_pw.<address>). The MAILROOM_GMAIL_APP_PW env var — which on the
 * MCPB build is fed from the macOS Keychain via a sensitive user_config
 * field — applies strictly to the address named by MAILROOM_GMAIL_ADDRESS.
 * Additional accounts store their password with
 * `mailroom set-gmail-password --account <address>` on the host.
 *
 * The credentials directory lives under broker/ — outside room/ — so the MCP
 * tools and the in-room `mail` CLI never expose it to the agent.
 */

import fs from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import { cleanEnvValue } from "./config.js";
import type { Layout } from "./layout.js";

export const APP_PW_ENV = "MAILROOM_GMAIL_APP_PW";

/**
 * Google displays app passwords in spaced groups (abcd efgh ...) and ignores
 * the spaces; strip all whitespace so what we send is the actual secret.
 */
export function normalizeAppPassword(value: string): string {
  return value.replace(/\s+/g, "");
}

function pwFile(layout: Layout, address: string): string {
  return path.join(layout.credentials, `gmail_app_pw.${address.toLowerCase()}`);
}

function envAppliesTo(
  _cfg: Config,
  address: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!cleanEnvValue(env, APP_PW_ENV)) return false;
  // The env password binds ONLY to the env-named address. There is no
  // "sole configured account" fallback: the account list is agent-mutable
  // (`mail account add`), so an ambient credential must never attach to
  // whatever account happens to be alone in the list — that would let an
  // injected instruction mint an authenticated (allowlisted) address.
  const envAddr = (
    cleanEnvValue(env, "MAILROOM_GMAIL_ADDRESS") ?? ""
  ).toLowerCase();
  return !!envAddr && envAddr === address.toLowerCase();
}

export function gmailAppPassword(
  layout: Layout,
  cfg: Config,
  address: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (envAppliesTo(cfg, address, env)) {
    const value = normalizeAppPassword(cleanEnvValue(env, APP_PW_ENV) ?? "");
    if (value) return value;
  }
  // per-address file only — a shared/legacy fallback would attach a stored
  // credential to agent-added accounts (see envAppliesTo)
  try {
    const value = normalizeAppPassword(
      fs.readFileSync(pwFile(layout, address), "utf-8"),
    );
    if (value) return value;
  } catch {
    /* not stored */
  }
  return null;
}

export function storeGmailAppPassword(
  layout: Layout,
  address: string,
  password: string,
): void {
  layout.ensureBroker();
  const file = pwFile(layout, address);
  fs.writeFileSync(file, normalizeAppPassword(password) + "\n");
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
  }
}
