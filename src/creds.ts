/**
 * Credential resolution for the broker — multi-account edition.
 *
 * Gmail app passwords live one file per address under broker/credentials/
 * (gmail_app_pw.<address>). The MESSAGEOPERATOR_GMAIL_APP_PW env var — which on the
 * MCPB build is fed from the macOS Keychain via a sensitive user_config
 * field — applies strictly to the address named by MESSAGEOPERATOR_GMAIL_ADDRESS.
 * Additional accounts store their password with
 * `messageoperator set-gmail-password --account <address>` on the host.
 *
 * The credentials directory lives under broker/ — outside room/ — so the MCP
 * tools and the in-room `mail` CLI never expose it to the agent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Config } from "./config.js";
import { cleanEnvValue } from "./config.js";
import type { Layout } from "./layout.js";

const execFileAsync = promisify(execFile);
export const APP_PW_ENV = "MESSAGEOPERATOR_GMAIL_APP_PW";

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

function xmlFile(layout: Layout, address: string): string {
  return pwFile(layout, address) + ".xml";
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

  const platform = os.platform();
  if (platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        address,
        "-s",
        "messageoperator",
        "-w",
      ]);
      return normalizeAppPassword(stdout.trim());
    } catch {
      /* fallback to legacy file */
    }
  } else if (platform === "win32") {
    const out = xmlFile(layout, address);
    if (fs.existsSync(out)) {
      try {
        const script = `$cred = New-Object System.Management.Automation.PSCredential 'dummy', (Import-Clixml -Path '${out.replace(/'/g, "''")}'); $cred.GetNetworkCredential().Password`;
        const { stdout } = await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          script,
        ]);
        return normalizeAppPassword(stdout.trim());
      } catch {
        /* fallback to legacy file */
      }
    }
  }

  // Fallback for Linux/Docker, OR graceful migration for users with an existing plain-text file
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

export async function storeGmailAppPassword(
  layout: Layout,
  address: string,
  password: string,
): Promise<void> {
  layout.ensureBroker();
  const norm = normalizeAppPassword(password);
  const platform = os.platform();

  if (platform === "darwin") {
    // -U creates or updates if it already exists
    await execFileAsync("security", [
      "add-generic-password",
      "-a",
      address,
      "-s",
      "messageoperator",
      "-w",
      norm,
      "-U",
    ]);
  } else if (platform === "win32") {
    const out = xmlFile(layout, address);
    // DPAPI locks it to the current Windows user's context securely
    const script = `$pw = ConvertTo-SecureString -String '${norm.replace(/'/g, "''")}' -AsPlainText -Force; $pw | Export-Clixml -Path '${out.replace(/'/g, "''")}'`;
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
  } else {
    // Docker/Linux plaintext strategy
    const file = pwFile(layout, address);
    fs.writeFileSync(file, norm + "\n");
    fs.chmodSync(file, 0o600);
  }
}

export async function deleteGmailAppPassword(
  layout: Layout,
  address: string,
): Promise<void> {
  const platform = os.platform();
  if (platform === "darwin") {
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-a",
        address,
        "-s",
        "messageoperator",
      ]);
    } catch {
      /* Already gone or never existed */
    }
  } else if (platform === "win32") {
    fs.rmSync(xmlFile(layout, address), { force: true });
  }

  // Always clean up the legacy fallback plain-text file just in case
  fs.rmSync(pwFile(layout, address), { force: true });
}
