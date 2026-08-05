/**
 * Credential resolution for the broker — multi-account edition.
 *
 * Storage itself belongs to src/secrets.ts: a Gmail app password goes into the
 * encrypted secrets volume, whose master key lives in the OS credential store,
 * and an app password left in the open by an older build is moved in there the
 * first time it is read. What lives HERE is the policy on top of it: which
 * address a password may be used for, and how a pasted password is normalized.
 *
 * The MESSAGEOPERATOR_GMAIL_APP_PW env var is a shell/dev convenience (it is
 * not an MCPB user_config field) and applies strictly to the address named by
 * MESSAGEOPERATOR_GMAIL_ADDRESS. Additional accounts store their password with
 * `messageoperator set-gmail-password --account <address>` on the host, or
 * through the setup wizard.
 */

import type { Config } from "./config.js";
import { cleanEnvValue } from "./config.js";
import type { Layout } from "./layout.js";
import {
  deleteSecret,
  getSecret,
  gmailSecretName,
  setSecret,
} from "./secrets.js";

export const APP_PW_ENV = "MESSAGEOPERATOR_GMAIL_APP_PW";

/**
 * Google displays app passwords in spaced groups (abcd efgh ...) and ignores
 * the spaces; strip all whitespace so what we send is the actual secret.
 */
export function normalizeAppPassword(value: string): string {
  return value.replace(/\s+/g, "");
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
    cleanEnvValue(env, "MESSAGEOPERATOR_GMAIL_ADDRESS") ?? ""
  ).toLowerCase();
  return !!envAddr && envAddr === address.toLowerCase();
}

export async function gmailAppPassword(
  layout: Layout,
  cfg: Config,
  address: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (envAppliesTo(cfg, address, env)) {
    const value = normalizeAppPassword(cleanEnvValue(env, APP_PW_ENV) ?? "");
    if (value) return value;
  }
  const stored = await getSecret(layout, gmailSecretName(address));
  return stored ? normalizeAppPassword(stored) : null;
}

export async function storeGmailAppPassword(
  layout: Layout,
  address: string,
  password: string,
): Promise<void> {
  layout.ensureBroker();
  const norm = normalizeAppPassword(password);
  if (!norm) throw new Error(`refusing to store an empty app password`);
  await setSecret(layout, gmailSecretName(address), norm);
}

export async function deleteGmailAppPassword(
  layout: Layout,
  address: string,
): Promise<void> {
  await deleteSecret(layout, gmailSecretName(address));
}
