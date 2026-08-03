/**
 * Entry points: `mailroom serve` (MCP stdio; what the MCPB bundle runs),
 * `mailroom broker` (standalone poll loop), and two host-side credential
 * helpers for terminal use — everything they do also happens lazily through
 * the extension settings + `mail login`, so they are conveniences, not
 * requirements.
 */

// Only Node built-ins at module scope: the serve path must reach the MCP
// handshake without waiting on (or being killed by) the provider dependency
// graph — every project module is imported dynamically per command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

function usage(): never {
  // writeSync: an async stderr write would be dropped by the exit below
  fs.writeSync(
    2,
    "usage: mailroom <serve | broker [--once] [--interval N] | " +
      "login [--account ADDRESS] | set-gmail-password --account ADDRESS>\n",
  );
  process.exit(1);
}

async function login(addressArg?: string): Promise<number> {
  const [
    { Layout },
    { ensureDefaultConfig, loadConfig, accountsFor },
    msgraph,
  ] = await Promise.all([
    import("./layout.js"),
    import("./config.js"),
    import("./msgraph.js"),
  ]);
  const layout = new Layout();
  layout.ensureBroker();
  ensureDefaultConfig(layout.configPath);
  const cfg = loadConfig(layout.configPath);
  const candidates = accountsFor(cfg, "microsoft").filter((a) => a.client_id);
  const acct = addressArg
    ? candidates.find((a) => a.address === addressArg.toLowerCase())
    : candidates[0];
  if (!acct) {
    process.stderr.write(
      addressArg
        ? `no configured microsoft account matches ${addressArg}\n`
        : `no microsoft account with a client_id is configured (config: ${layout.configPath})\n`,
    );
    return 1;
  }
  const manager = new msgraph.LoginManager();
  const url = await manager.ensureFlow(layout, acct, { autoOpen: true });
  process.stdout.write(
    `sign-in started for ${acct.address}; if no browser opened, visit:\n${url}\n`,
  );
  // wait for the loopback redirect to resolve the flow
  while (Object.keys(manager.pendingUrls()).length) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  const outcome = manager.outcome(acct.address) ?? "unknown";
  if (outcome !== "ok") {
    process.stderr.write(`login did not complete: ${outcome}\n`);
    return 1;
  }
  // prove the token grants mailbox access now — a missing Mail.ReadWrite
  // permission would otherwise only surface on the first sync
  const token = await msgraph.acquireTokenSilentFor(layout, acct);
  if (!token) {
    process.stderr.write(
      "signed in, but no token could be acquired silently\n",
    );
    return 1;
  }
  try {
    const inbox = await msgraph.verifyMailbox(token);
    process.stdout.write(
      `logged in as ${acct.address}; mailbox verified ` +
        `(INBOX: ${inbox.totalItemCount ?? "?"} messages); token cached under ` +
        `${layout.credentials} and refreshed silently from now on\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `signed in, but the mailbox check failed: ${err}\n` +
        "check the app registration's API permissions (Microsoft Graph " +
        "delegated: Mail.ReadWrite, Mail.Send) and retry\n",
    );
    return 1;
  }
}

async function setGmailPassword(addressArg?: string): Promise<number> {
  const [
    { Layout },
    { ensureDefaultConfig, loadConfig, accountsFor, findAccount },
    { normalizeAppPassword, storeGmailAppPassword, APP_PW_ENV },
    gmail,
  ] = await Promise.all([
    import("./layout.js"),
    import("./config.js"),
    import("./creds.js"),
    import("./gmail.js"),
  ]);
  const layout = new Layout();
  ensureDefaultConfig(layout.configPath);
  const cfg = loadConfig(layout.configPath);
  const gmailAccounts = accountsFor(cfg, "gmail");
  const address =
    addressArg?.toLowerCase() ??
    (gmailAccounts.length === 1 ? gmailAccounts[0]?.address : undefined);
  if (!address) {
    process.stderr.write(
      "pass --account <address> (multiple gmail accounts are configured)\n",
    );
    return 1;
  }
  if (!findAccount(cfg, address)) {
    process.stderr.write(
      `note: ${address} is not in the config yet; storing the password anyway\n`,
    );
  }
  let password = process.env[APP_PW_ENV];
  if (password) {
    process.stdout.write(
      `using the password from ${APP_PW_ENV} set in this shell\n`,
    );
  } else {
    password = await promptHidden("Gmail app password: ");
  }
  password = normalizeAppPassword(password ?? "");
  if (!password) {
    process.stderr.write("no password provided\n");
    return 1;
  }
  if (!/^[\x00-\x7f]*$/.test(password)) {
    process.stderr.write(
      "password contains non-ASCII character(s) — likely a dead-key or paste " +
        "artifact; please retype it\n",
    );
    return 1;
  }
  if (password.length !== 16 || !/^[a-zA-Z]+$/.test(password)) {
    process.stderr.write(
      `warning: expected 16 letters (got ${password.length} chars); storing anyway\n`,
    );
  }
  try {
    await gmail.verifyLogin(address, password);
    process.stdout.write(`verified: IMAP login OK for ${address}\n`);
  } catch (err) {
    if (err instanceof gmail.GmailAuthError) {
      process.stderr.write(
        `Gmail refused the login for ${address}: ${err.message}\n` +
          "nothing stored — check the app password " +
          "(https://myaccount.google.com/apppasswords) and retry\n",
      );
      return 1;
    }
    process.stderr.write(
      `warning: could not reach Gmail to verify (${err}); storing anyway\n`,
    );
  }
  storeGmailAppPassword(layout, address, password);
  process.stdout.write(
    `stored Gmail app password for ${address} under ${layout.credentials}\n`,
  );
  return 0;
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    // hide input: readline echoes via the output stream; mute writes after the prompt
    process.stderr.write(prompt);
    const stream = rl as unknown as { _writeToOutput?: (s: string) => void };
    stream._writeToOutput = () => {};
    rl.question("", (answer) => {
      process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  // Crash visibility: the MCP host only shows "server transport closed
  // unexpectedly" when the process dies, and (observed on Claude Desktop
  // macOS) this server's stderr never reaches the host log — so crashes are
  // also appended to broker/serve-crash.log under MAILROOM_HOME, where they
  // can actually be found. writeSync/appendFileSync: async writes would be
  // dropped by the exit.
  const reportCrash = (label: string, detail: unknown): void => {
    const stack = detail instanceof Error ? detail.stack : undefined;
    const line = `${new Date().toISOString()} mailroom ${label}: ${stack || detail}\n`;
    try {
      fs.writeSync(2, line);
    } catch {
      /* stderr gone */
    }
    try {
      const home =
        (process.env.MAILROOM_HOME || "").trim() ||
        path.join(os.homedir(), "mailroom");
      fs.appendFileSync(path.join(home, "broker", "serve-crash.log"), line);
    } catch {
      /* broker dir may not exist yet */
    }
  };
  process.on("uncaughtException", (err) => {
    reportCrash("FATAL uncaughtException", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    // do not exit: the broker's state is filesystem-based and crash-safe,
    // and a rejected background promise must not take tool calls down
    reportCrash("ERROR unhandledRejection", reason);
  });

  if (command === "serve") {
    const { serve } = await import("./server.js");
    await serve();
    return 0;
  }

  if (command === "login") {
    const i = rest.indexOf("--account");
    return login(i >= 0 ? rest[i + 1] : undefined);
  }

  if (command === "set-gmail-password") {
    const i = rest.indexOf("--account");
    return setGmailPassword(i >= 0 ? rest[i + 1] : undefined);
  }

  if (command === "broker") {
    const [{ Broker }, { log }] = await Promise.all([
      import("./broker.js"),
      import("./log.js"),
    ]);
    const once = rest.includes("--once");
    const i = rest.indexOf("--interval");
    const interval = i >= 0 ? Number(rest[i + 1]) || 120 : 120;
    const broker = new Broker(undefined, { mode: "daemon" });
    if (once) {
      await broker.runCycle();
      broker.close();
      return 0;
    }
    process.on("SIGINT", () => {
      log.info("stopped");
      broker.close();
      process.exit(0);
    });
    await broker.runForever(interval);
    return 0;
  }

  usage();
}

main().then(
  (code) => {
    if (code) process.exit(code);
  },
  (err) => {
    // synchronous write: process.stderr to a pipe is async-buffered, and
    // exiting right after an async write drops the one message that would
    // have explained the crash in Claude Desktop's log
    try {
      fs.writeSync(2, `mailroom FATAL: ${err?.stack || err}\n`);
    } catch {
      /* nowhere to report */
    }
    process.exit(1);
  },
);
