/**
 * Gmail app-password onboarding: a one-shot loopback wizard page.
 *
 * Gmail has no OAuth path a self-hosted tool can realistically use for full
 * IMAP access (restricted-scope verification, or 7-day test tokens), so the
 * credential is an app password — and the UX problem is that users don't
 * know what that is or where to put it. This flow answers both: `mail login
 * <gmail-address>` opens a local browser page that walks the user through
 * creating the app password on Google's site and gives them a paste box
 * right there. The submitted password is verified against Gmail's IMAP
 * before it is accepted (a typo fails on the page, with a retry form, not
 * mysteriously later) and then handed to the broker for storage under
 * broker/credentials/ — it never appears in the chat, the room, the ledger,
 * or the agent's tool results.
 *
 * Structurally a sibling of msgraph.ts's LoginManager: one pending flow per
 * address, resolves in the background between tool calls, URL published via
 * `mail status` (auth_urls), timeout closes the listener. The URL carries a
 * random nonce and the form only accepts a POST to that nonce, so nothing
 * else on the machine can spray candidate passwords at the listener or
 * discover the page by port scanning.
 */

import { randomBytes } from "node:crypto";
import http from "node:http";
import { AddressInfo } from "node:net";

import { GmailAuthError, verifyLogin } from "./gmail.js";
import { openBrowser } from "./msgraph.js";
import { log } from "./log.js";

const SETUP_TIMEOUT_MS = 15 * 60_000; // creating an app password takes a while
const MAX_BODY_BYTES = 8192;

export interface GmailSetupOptions {
  /** IMAP credential check; defaults to a real Gmail login round trip. */
  verify?: (address: string, password: string) => Promise<void>;
  /** Called with the accepted password; the broker stores it. */
  onStored?: (address: string, password: string) => void;
  autoOpen?: boolean;
}

interface PendingSetup {
  url: string;
  server: http.Server;
  timer: NodeJS.Timeout;
}

export class GmailSetupFlow {
  private pending = new Map<string, PendingSetup>();
  private lastOutcome = new Map<string, string>();
  /** addresses the broker already auto-triggered this process run */
  readonly autoAttempted = new Set<string>();

  pendingUrls(): Record<string, string> {
    return Object.fromEntries(
      [...this.pending].map(([addr, flow]) => [addr, flow.url]),
    );
  }

  outcome(address: string): string | undefined {
    return this.lastOutcome.get(address.toLowerCase());
  }

  /**
   * Start (or return the already-pending) setup wizard for an address.
   * Returns the URL the user must open; also opens the browser when
   * `autoOpen` is set.
   */
  async ensureFlow(
    address: string,
    opts: GmailSetupOptions = {},
  ): Promise<string> {
    const addr = address.toLowerCase();
    const existing = this.pending.get(addr);
    if (existing) {
      if (opts.autoOpen) openBrowser(existing.url);
      return existing.url;
    }

    const verify = opts.verify ?? verifyLogin;
    const nonce = randomBytes(16).toString("hex");
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/setup/${nonce}`;

    const finish = (outcome: string) => {
      this.lastOutcome.set(addr, outcome);
      const flow = this.pending.get(addr);
      if (flow) {
        clearTimeout(flow.timer);
        flow.server.close();
        this.pending.delete(addr);
      }
    };

    server.on("request", (req, res) => {
      const reqPath = new URL(req.url ?? "/", url).pathname;
      if (reqPath !== `/setup/${nonce}`) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
        return;
      }
      if (req.method === "GET") {
        respondHtml(res, wizardPage(addr, null));
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
        void handleSubmit().catch((err) => {
          // e.g. onStored failed to write the credential file: surface it on
          // the page and keep the flow pending — never an unhandled rejection
          log.error(`gmail setup: submit for ${addr} failed: ${err}`);
          try {
            respondHtml(
              res,
              wizardPage(
                addr,
                "Something went wrong on this computer while saving the code " +
                  `(${err}). The code was NOT stored — try again.`,
              ),
            );
          } catch {
            /* response already sent or connection gone */
          }
        });

        async function handleSubmit(): Promise<void> {
          const password = String(
            new URLSearchParams(body).get("password") ?? "",
          ).replace(/\s+/g, "");
          if (!password) {
            respondHtml(
              res,
              wizardPage(addr, "Paste the 16-letter code before submitting."),
            );
            return;
          }
          if (!/^[\x00-\x7f]*$/.test(password)) {
            respondHtml(
              res,
              wizardPage(
                addr,
                "That code contains a non-ASCII character — usually a dead-key slip " +
                  "(à, ´, …) or a paste artifact. Re-copy it from Google and try again.",
              ),
            );
            return;
          }
          try {
            await verify(addr, password);
          } catch (err) {
            if (err instanceof GmailAuthError) {
              respondHtml(
                res,
                wizardPage(
                  addr,
                  `Gmail refused that code for ${addr}. Double-check that you were ` +
                    "signed in as this exact address when you created it, then try again.",
                ),
              );
              return;
            }
            // Gmail unreachable, not a refusal: accept with a warning (same
            // call as `mailroom set-gmail-password`); the next sync will tell.
            opts.onStored?.(addr, password);
            respondHtml(res, donePage(addr, true));
            finish("ok_unverified");
            log.warn(
              `gmail setup: could not verify ${addr} (${err}); stored anyway`,
            );
            return;
          }
          opts.onStored?.(addr, password);
          respondHtml(res, donePage(addr, false));
          finish("ok");
          log.info(`gmail setup: app password verified and stored for ${addr}`);
        }
      });
    });

    const timer = setTimeout(() => {
      log.info(`gmail setup: wizard for ${addr} timed out; closing listener`);
      finish("timed_out");
    }, SETUP_TIMEOUT_MS);
    timer.unref();

    this.pending.set(addr, { url, server, timer });
    log.info(`gmail setup: wizard for ${addr} listening on ${url}`);
    if (opts.autoOpen) openBrowser(url);
    return url;
  }

  closeAll(): void {
    for (const address of [...this.pending.keys()]) {
      const flow = this.pending.get(address);
      if (flow) {
        clearTimeout(flow.timer);
        flow.server.close();
        this.pending.delete(address);
      }
    }
  }
}

export function respondHtml(res: http.ServerResponse, html: string): void {
  res
    .writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    .end(html);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Adeu brand (prospect-deck/docs/design-system.md): Nordic palette, Lora
// headings / Jost body (system fallbacks — the page deliberately makes NO
// external requests, so nothing loads from any CDN), sand CTAs, mint trust
// accents, navy text. The icon mark is inlined from the brand assets.
const ADEU_MARK = `<svg class="mark" viewBox="0 0 241 241" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="241" height="241" rx="48" fill="#1a2a2c"/><path d="M173.505 155.679C175.621 155.674 177.531 154.795 178.894 153.384C180.257 151.974 181 150.195 181 148.169V93.9063C181 91.8323 180.16 89.9548 178.802 88.5966C177.444 87.2369 175.566 86.3964 173.492 86.3964C171.764 86.3964 168.079 86.3964 164.644 86.3964C162.569 86.3964 160.692 85.5543 159.332 84.1946C157.972 82.8348 157.134 80.9557 157.135 78.8801L157.143 67.4971C157.14 65.4263 156.298 63.552 154.938 62.1954C153.58 60.8389 151.705 60 149.634 60H72.97V86.3916H143.115C145.186 86.3916 145.791 89.215 143.905 90.065L81.7717 116.337C70.1324 121.265 61 132.732 61 147.369C61 166.563 76.5025 181 94.5932 181H149.632C151.888 181 153.911 180.006 155.287 178.432C156.442 177.112 157.142 175.384 157.142 173.492V163.187C157.142 161.113 157.984 159.237 159.342 157.878C160.701 156.518 162.58 155.677 164.656 155.677H173.507L173.505 155.679ZM99.757 154.546C94.4159 154.546 91.1662 150.246 91.1662 146.105C91.1662 142.227 93.6298 139.4 96.2021 138.29L149.112 115.349C150.262 114.833 151.487 115.017 152.408 115.651C153.272 116.247 153.865 117.243 153.866 118.428L153.869 147.036C153.869 149.11 153.029 150.988 151.671 152.347C150.313 153.707 148.434 154.548 146.36 154.548H99.757V154.546Z" fill="#f0f0f0"/></svg>`;

const PAGE_STYLE = `
  :root {
    --sand: #e8c0a1; --sand-light: #f2d9c7; --sand-dark: #d4a882;
    --mint: #e6f3f0; --mint-dark: #c9e4de;
    --navy: #1a2a2c; --navy-light: #2a3a3c;
    --bg: #fafafa; --border: #e5e5e5; --body: #555969; --muted: #737373;
  }
  * { box-sizing: border-box; }
  body { font: 16px/1.6 Jost, system-ui, -apple-system, sans-serif;
         color: var(--body); background: var(--bg); margin: 0;
         padding: 2.5rem 1.25rem 3rem; }
  .page { max-width: 640px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: .65rem; margin-bottom: 1.6rem; }
  .mark { width: 34px; height: 34px; border-radius: 8px; flex: none; }
  .wordmark { font: 600 1.05rem/1 Jost, system-ui, sans-serif; color: var(--navy);
         letter-spacing: .01em; }
  .wordmark small { display: block; font-weight: 500; font-size: .72rem;
         color: var(--muted); letter-spacing: .05em; text-transform: uppercase;
         margin-top: .2rem; }
  .card { background: #fff; border: 1px solid var(--border); border-radius: 16px;
         padding: 1.8rem 1.9rem; box-shadow: 0 1px 2px rgba(26,42,44,.04),
         0 8px 24px rgba(26,42,44,.05); }
  h1, h2 { font-family: Lora, Georgia, serif; font-weight: 600; color: var(--navy);
         letter-spacing: -.02em; }
  h1 { font-size: 1.55rem; margin: 0 0 .7rem; }
  h2 { font-size: 1.02rem; margin: 0 0 .55rem; }
  ol { padding-left: 1.25rem; margin: 1.4rem 0 0; }
  ol > li { margin: 1.15rem 0; padding-left: .35rem; }
  ol > li::marker { font-weight: 600; color: var(--navy); }
  .addr { font-weight: 600; color: var(--navy); white-space: nowrap; }
  a { color: var(--navy); }
  .btn { display: inline-block; padding: .6rem 1.1rem; border-radius: 999px;
         background: var(--sand); color: var(--navy); text-decoration: none;
         font-weight: 600; transition: background .15s; }
  .btn:hover { background: var(--sand-dark); }
  input[type=text] { font: 19px/1.4 ui-monospace, SFMono-Regular, monospace;
         letter-spacing: .14em; padding: .65rem .8rem; margin-top: .6rem;
         border: 1px solid var(--border); border-radius: 10px; width: 100%;
         background: var(--bg); color: var(--navy); }
  input[type=text]:focus { outline: 2px solid var(--sand); border-color: var(--sand); }
  button { font: 600 16px Jost, system-ui, sans-serif; margin-top: .8rem;
         padding: .65rem 1.35rem; border: 0; border-radius: 999px;
         background: var(--navy); color: #fff; cursor: pointer;
         transition: background .15s; }
  button:hover { background: var(--navy-light); }
  .error { background: #fef2f2; border: 1px solid #fecaca; color: #7f1d1d;
         border-radius: 10px; padding: .75rem .95rem; margin: 1.1rem 0 0; }
  .note { color: var(--muted); font-size: .88rem; }
  .trust { background: var(--mint); border: 1px solid var(--mint-dark);
         border-radius: 16px; padding: 1.3rem 1.5rem; margin-top: 1.1rem; }
  .trust ul { margin: 0; padding-left: 1.15rem; }
  .trust li { margin: .55rem 0; font-size: .92rem; }
  .trust code { font-size: .85em; background: rgba(26,42,44,.06);
         padding: .1em .35em; border-radius: 5px; }
  footer { text-align: center; margin-top: 1.6rem; font-size: .82rem;
         color: var(--muted); }
  footer a { color: var(--muted); }
  .ok-badge { width: 56px; height: 56px; border-radius: 50%; background: var(--mint);
         border: 1px solid var(--mint-dark); display: flex; align-items: center;
         justify-content: center; font-size: 1.7rem; color: var(--navy);
         margin-bottom: 1rem; }
`;

export function pageChrome(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${PAGE_STYLE}</style></head>
<body><div class="page">
  <header>
    ${ADEU_MARK}
    <div class="wordmark">Mailroom<small>by Adeu</small></div>
  </header>
  ${body}
  <footer>Mailroom by <a href="https://adeu.ai" target="_blank" rel="noopener noreferrer">Adeu</a>
  &nbsp;·&nbsp; running locally on your computer</footer>
</div></body></html>`;
}

/** The trust panel: plain statements about where the secret lives. */
function trustPanel(): string {
  return `<div class="trust">
    <h2>Where your code is kept</h2>
    <ul>
      <li><b>Only on this computer.</b> The code is saved under
        <code>~/mailroom/broker/credentials/</code>, outside the AI&nbsp;agent's
        workspace, and never appears in your conversation.</li>
      <li><b>Never sent to Adeu or Anthropic.</b> Mailroom has no cloud
        service — the code is used by this computer only, to connect directly
        to Google's mail servers over an encrypted connection.</li>
      <li><b>Revocable any time.</b> Delete it at
        <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">Google App Passwords</a>
        and Mailroom's access ends immediately. Your real Google password is
        never used or stored.</li>
      <li><b>This page is local.</b> It is served by Mailroom itself at
        <code>127.0.0.1</code> on your machine — it is not a website, and it
        makes no requests anywhere except when you submit, to verify the code
        with Gmail.</li>
    </ul>
  </div>`;
}

function wizardPage(address: string, error: string | null): string {
  const addr = escapeHtml(address);
  return pageChrome(
    `Connect ${addr} to Mailroom`,
    `<div class="card">
    <h1>Connect <span class="addr">${addr}</span></h1>
    <p>Mailroom reads and sends your mail with a Google <b>app password</b> —
    a 16-letter code that works only for mail apps and can be revoked any
    time. Two steps:</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <ol>
      <li>
        <a class="btn" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">Open Google App Passwords&nbsp;↗</a>
        <p>Sign in as <span class="addr">${addr}</span> (check the avatar in
        the top-right corner). Type <b>Mailroom</b> as the app name and click
        <b>Create</b>.</p>
        <p class="note">If Google says app passwords are not available, turn on
        <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener noreferrer">2-Step Verification</a>
        first, then come back to this step.</p>
      </li>
      <li>
        Copy the 16-letter code Google shows you and paste it here
        (spaces are fine):
        <form method="POST" autocomplete="off">
          <input type="text" name="password" placeholder="abcd efgh ijkl mnop"
                 autofocus autocomplete="off" spellcheck="false"
                 aria-label="Google app password">
          <br><button type="submit">Connect mailbox</button>
        </form>
      </li>
    </ol>
  </div>
  ${trustPanel()}`,
  );
}

function donePage(address: string, unverified: boolean): string {
  const addr = escapeHtml(address);
  const verifiedLine = unverified
    ? `<p><b>Note:</b> Gmail could not verify the code right now (network
       problem), so it was stored as-is. If <code>mail status</code> still
       shows a problem after the next sync, run the setup again.</p>`
    : `<p>The code was verified with Gmail and saved on this computer —
       under <code>~/mailroom/broker/credentials/</code>, outside the
       AI&nbsp;agent's workspace. It was not sent to Adeu, Anthropic, or any
       cloud service, and it never appears in your conversation.</p>`;
  return pageChrome(
    `${addr} connected`,
    `<div class="card">
    <div class="ok-badge">✓</div>
    <h1><span class="addr">${addr}</span> is connected</h1>
    ${verifiedLine}
    <p>You can close this tab and go back to your conversation — mail starts
    syncing on the next request.</p>
  </div>`,
  );
}
