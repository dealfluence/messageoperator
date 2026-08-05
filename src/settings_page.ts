/**
 * The Message Operator settings page: a one-shot loopback control panel.
 *
 * Policy (dry_run, recipient allowlist) and account removal are the user's
 * to change, never the agent's — a prompt-injected email must not be able to
 * disable the safety rails. So, like the Gmail wizard, this is a
 * nonce-protected page served on 127.0.0.1: the agent may OPEN it
 * (`mail settings`), only the human clicks. Choices are persisted via
 * config.saveSettingsPage() and win over the extension pane's env injection
 * from then on, so they survive restarts and reinstalls.
 *
 * Structurally a sibling of gmail_setup's GmailSetupFlow and reuses its page
 * chrome (Adeu branding, zero external requests).
 */

import { randomBytes } from "node:crypto";
import http from "node:http";
import { AddressInfo } from "node:net";

import { escapeHtml, pageChrome, respondHtml } from "./gmail_setup.js";
import { openBrowser } from "./msgraph.js";
import { log } from "./log.js";

const PAGE_TIMEOUT_MS = 15 * 60_000;
const MAX_BODY_BYTES = 16384;

export interface SettingsAccountView {
  address: string;
  provider: string;
  auth: string; // ok | needs_login | no_app_password | ...
}

export interface SettingsState {
  accounts: SettingsAccountView[];
  dry_run: boolean;
  dry_run_source: string;
  allowed_recipient_domains: string[];
}

export interface SettingsPageOptions {
  /** Fresh state per render; called on every GET/after every action. */
  getState: () => Promise<SettingsState> | SettingsState;
  /**
   * Persist safety settings (dry_run, allowlist). Awaited, so a hook that
   * republishes the room's status file finishes before the page confirms.
   */
  onSaveSafety: (values: {
    dry_run: boolean;
    allowed_recipient_domains: string[];
  }) => void | Promise<void>;
  /** Remove an account (credential + config); deleteLocal = also queue local mail deletion. */
  onRemoveAccount: (
    address: string,
    deleteLocal: boolean,
  ) => void | Promise<void>;
  autoOpen?: boolean;
}

interface PendingPage {
  url: string;
  server: http.Server;
  timer: NodeJS.Timeout;
}

export class SettingsPageFlow {
  private pending: PendingPage | null = null;

  pendingUrl(): string | null {
    return this.pending?.url ?? null;
  }

  async ensureFlow(opts: SettingsPageOptions): Promise<string> {
    if (this.pending) {
      if (opts.autoOpen) openBrowser(this.pending.url);
      return this.pending.url;
    }
    const nonce = randomBytes(16).toString("hex");
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/settings/${nonce}`;

    const close = (reason: string): void => {
      if (!this.pending) return;
      clearTimeout(this.pending.timer);
      this.pending.server.close();
      this.pending = null;
      log.info(`settings page closed (${reason})`);
    };

    server.on("request", (req, res) => {
      void (async () => {
        const reqPath = new URL(req.url ?? "/", url).pathname;
        if (reqPath !== `/settings/${nonce}`) {
          res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
          return;
        }
        if (req.method === "GET") {
          respondHtml(res, renderPage(await opts.getState(), null));
          return;
        }
        if (req.method !== "POST") {
          res
            .writeHead(405, { "Content-Type": "text/plain" })
            .end("method not allowed");
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > MAX_BODY_BYTES) req.destroy();
        });
        req.on("end", () => {
          void (async () => {
            let notice: string | null = null;
            try {
              const form = new URLSearchParams(body);
              const action = form.get("action") ?? "";
              if (action === "save_safety") {
                const domains = String(
                  form.get("allowed_recipient_domains") ?? "",
                )
                  .split(",")
                  .map((d) => d.trim())
                  .filter(Boolean);
                await opts.onSaveSafety({
                  dry_run: form.get("dry_run") === "on",
                  allowed_recipient_domains: domains,
                });
                notice =
                  "Saved. Changes apply from your next message in the chat.";
              } else if (action === "remove_account") {
                const address = String(form.get("address") ?? "").toLowerCase();
                if (address) {
                  await opts.onRemoveAccount(
                    address,
                    form.get("delete_local") === "on",
                  );
                  notice = `Removed ${address}. Remember: to fully revoke access, also delete its app password / sign-in at the provider.`;
                }
              }
            } catch (err) {
              notice = `Something went wrong: ${err}. Nothing may have been saved — check and retry.`;
              log.error(`settings page action failed: ${err}`);
            }
            respondHtml(res, renderPage(await opts.getState(), notice));
          })();
        });
      })();
    });

    const timer = setTimeout(() => close("timed out"), PAGE_TIMEOUT_MS);
    timer.unref();
    this.pending = { url, server, timer };
    log.info(`settings page listening on ${url}`);
    if (opts.autoOpen) openBrowser(url);
    return url;
  }

  closeAll(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.server.close();
      this.pending = null;
    }
  }
}

const AUTH_CHIPS: Record<string, [string, string, string]> = {
  // state -> [label, bg, fg]
  ok: ["Connected", "#e6f3f0", "#0f6e56"],
  needs_login: ["Needs sign-in", "#faeeda", "#854f0b"],
  no_app_password: ["Needs setup", "#faeeda", "#854f0b"],
  bad_app_password: ["Bad app password", "#fef2f2", "#7f1d1d"],
};

function chip(auth: string): string {
  const [label, bg, fg] = AUTH_CHIPS[auth] ?? [auth, "#f5f5f5", "#555969"];
  return `<span style="background:${bg};color:${fg};font-size:.72rem;padding:.15rem .6rem;border-radius:999px;white-space:nowrap;">${escapeHtml(label)}</span>`;
}

function sourceNote(source: string): string {
  if (source === "settings_page") return "set on this page";
  if (source === "extension_settings")
    return "currently set by the extension settings — saving here takes over";
  return "default";
}

function renderPage(state: SettingsState, notice: string | null): string {
  const accountRows = state.accounts.length
    ? state.accounts
        .map(
          (a) => `
      <div style="display:flex;align-items:center;gap:.7rem;padding:.55rem 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
        <div style="flex:1;min-width:12rem;">
          <span class="addr">${escapeHtml(a.address)}</span>
          <span class="note" style="margin-left:.4rem;">${escapeHtml(a.provider)}</span>
        </div>
        ${chip(a.auth)}
        <details>
          <summary style="cursor:pointer;font-size:.85rem;color:var(--muted);">Remove…</summary>
          <form method="POST" style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding: .7rem .9rem;margin-top:.5rem;">
            <input type="hidden" name="action" value="remove_account">
            <input type="hidden" name="address" value="${escapeHtml(a.address)}">
            <p style="margin:.2rem 0;font-size:.88rem;">Stops syncing and deletes the stored credential from this
            computer. Mail already copied locally is kept unless you tick:</p>
            <label style="font-size:.88rem;"><input type="checkbox" name="delete_local"> also delete the local mail copy</label><br>
            <button type="submit" style="margin-top:.6rem;">Remove mailbox</button>
          </form>
        </details>
      </div>`,
        )
        .join("")
    : `<p class="note">No mailboxes connected yet — ask Claude to “connect my mailbox you@example.com”.</p>`;

  return pageChrome(
    "Message Operator settings",
    `${notice ? `<div class="trust" style="margin-bottom:1rem;">${escapeHtml(notice)}</div>` : ""}
  <div class="card">
    <h1>Message Operator settings</h1>
    <p class="note">Claude can open this page but cannot click anything here — only you can.
    Changes are saved on this computer and apply from your next chat message.</p>

    <h2 style="margin-top:1.2rem;">Mailboxes</h2>
    ${accountRows}
    <p class="note" style="margin-top:.6rem;">To add a mailbox, ask Claude:
    <span style="font-family:ui-monospace,monospace;">connect my mailbox you@example.com</span></p>

    <h2 style="margin-top:1.6rem;">Sending safety</h2>
    <form method="POST">
      <input type="hidden" name="action" value="save_safety">
      <label style="display:flex;gap:.6rem;align-items:baseline;">
        <input type="checkbox" name="dry_run" ${state.dry_run ? "checked" : ""}>
        <span><b>Dry run</b> — outgoing mail is simulated, nothing is actually
        delivered <span class="note">(${escapeHtml(sourceNote(state.dry_run_source))})</span></span>
      </label>
      <p style="margin:.9rem 0 .2rem;"><b>Allowed recipient domains</b>
      <span class="note">— comma-separated; empty means mail may only go to your own
      connected addresses</span></p>
      <input type="text" name="allowed_recipient_domains"
             value="${escapeHtml(state.allowed_recipient_domains.join(", "))}"
             placeholder="example.com, partner.org">
      <br><button type="submit">Save safety settings</button>
    </form>
  </div>
  <div class="trust">
    Everything on this page lives in <span style="font-family:ui-monospace,monospace;">~/messageoperator/broker/</span>
    on this computer. Nothing is sent to Adeu or Anthropic. Turning dry run off means
    Message Operator really delivers mail — the recipient allowlist above still applies.
  </div>`,
  );
}
