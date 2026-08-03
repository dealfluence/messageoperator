/**
 * Which provider hosts a mailbox? Well-known consumer domains answer
 * directly; custom domains (Google Workspace, Microsoft 365) are resolved
 * by their MX records, so the user is never asked a question DNS can
 * answer. Detection failure returns null — the caller falls back to asking
 * the human (`mail login <address> --provider ...`).
 *
 * Runs only in the broker (host side): the in-room `mail` CLI never touches
 * the network, so it forwards the raw request and the broker detects here.
 */

import dns from "node:dns";

import type { Provider } from "./config.js";

export type MxResolver = (
  domain: string,
) => Promise<Array<{ exchange: string; priority: number }>>;

const GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const MICROSOFT_DOMAINS = new Set([
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
]);

// Google Workspace MX: aspmx.l.google.com and friends.
const GOOGLE_MX_SUFFIXES = [".google.com", ".googlemail.com"];
// Microsoft 365 MX: <domain>.mail.protection.outlook.com (and the
// consumer-migration olc variant).
const MICROSOFT_MX_SUFFIXES = [
  ".mail.protection.outlook.com",
  ".olc.protection.outlook.com",
];

export async function detectProvider(
  address: string,
  resolveMx: MxResolver = dns.promises.resolveMx,
): Promise<Provider | null> {
  const domain = address.split("@")[1]?.trim().toLowerCase();
  if (!domain) return null;
  if (GOOGLE_DOMAINS.has(domain)) return "gmail";
  if (MICROSOFT_DOMAINS.has(domain)) return "microsoft";

  let records: Array<{ exchange: string }>;
  try {
    records = await resolveMx(domain);
  } catch {
    return null;
  }
  const hosts = (records ?? []).map((r) =>
    String(r.exchange ?? "")
      .toLowerCase()
      .replace(/\.$/, ""),
  );
  if (hosts.some((h) => GOOGLE_MX_SUFFIXES.some((s) => h.endsWith(s))))
    return "gmail";
  if (hosts.some((h) => MICROSOFT_MX_SUFFIXES.some((s) => h.endsWith(s))))
    return "microsoft";
  return null;
}
