#!/usr/bin/env node
/**
 * Mailroom ingest CLI (read-only against providers).
 *
 *   node ingest/cli.mjs backfill [address]     backfill All Mail (+sent bodies)
 *   node ingest/cli.mjs coverage               honest per-account coverage
 *   node ingest/cli.mjs search "<query>" [--account A]
 *   node ingest/cli.mjs find [--account A] [--sender S] [--since ISO] [--until ISO]
 *                            [--archived] [--tag T] [--subject S] [--limit N]
 *   node ingest/cli.mjs get <id>               message metadata + tags + body?
 *
 * Store: MAILROOM_INGEST_HOME (default ~/mailroom-ingest).
 * Creds/accounts: reused from MAILROOM_HOME's broker config + credentials.
 */
import fs from "node:fs";
import path from "node:path";

import { openDb } from "./src/db.mjs";
import { storePaths, loadAccounts, gmailPassword } from "./src/config.mjs";
import { connectGmail, GmailAuthError } from "./src/imap.mjs";
import { backfillAllMail } from "./src/gmail_source.mjs";
import { bodyText } from "./src/parse.mjs";
import { coverageReport, formatCoverage } from "./src/coverage.mjs";
import {
  upsertAccount,
  search as ftsSearch,
  findMessages,
  getBody,
  tagsOf,
} from "./src/store.mjs";

const paths = storePaths();

function logLine(msg) {
  const line = `${new Date().toISOString()}  ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(paths.home, { recursive: true });
    fs.appendFileSync(path.join(paths.home, "progress.log"), line + "\n");
  } catch {
    /* logging must never crash ingestion */
  }
}

function markAuthBlocked(db, address, provider, mailbox, note) {
  upsertAccount(db, address, provider);
  db.prepare(
    `INSERT INTO sync_state(account,mailbox,status,last_uid,updated_utc)
     VALUES(?,?,?,0,?)
     ON CONFLICT(account,mailbox) DO UPDATE SET status='auth_blocked', updated_utc=excluded.updated_utc`,
  ).run(address, mailbox, "auth_blocked", Date.now());
  logLine(`[skip] ${address}: ${note}`);
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

async function cmdBackfill(target) {
  const db = openDb(paths.db);
  const accounts = loadAccounts();
  const gmail = accounts.filter(
    (a) => a.provider === "gmail" && (!target || a.address === target),
  );
  const microsoft = accounts.filter(
    (a) => a.provider === "microsoft" && (!target || a.address === target),
  );

  if (!gmail.length && !microsoft.length) {
    logLine(
      `no matching accounts in broker config (target=${target ?? "all"})`,
    );
  }

  for (const acct of gmail) {
    const pw = gmailPassword(acct.address);
    if (!pw) {
      markAuthBlocked(
        db,
        acct.address,
        "gmail",
        "[Gmail]/All Mail",
        "no app password on this machine — see ACTION_REQUIRED.md",
      );
      continue;
    }
    logLine(`[gmail] ${acct.address}: connecting…`);
    let client;
    try {
      client = await connectGmail(acct.address, pw);
    } catch (err) {
      if (err instanceof GmailAuthError) {
        markAuthBlocked(
          db,
          acct.address,
          "gmail",
          "[Gmail]/All Mail",
          `IMAP auth refused: ${err.message}`,
        );
        continue;
      }
      logLine(`[gmail] ${acct.address}: connect failed: ${err}`);
      continue;
    }
    try {
      const res = await backfillAllMail(db, paths.mail, {
        account: acct.address,
        client,
        batchSize: 500,
        sentBodies: true,
        parseBody: bodyText,
        log: (m) => logLine(`[gmail] ${acct.address}: ${m}`),
      });
      logLine(
        `[gmail] ${acct.address}: DONE stored=${res.stored} lastUid=${res.lastUid} (${res.allPath})`,
      );
    } catch (err) {
      logLine(
        `[gmail] ${acct.address}: backfill error (will resume on rerun): ${err}`,
      );
    } finally {
      try {
        await client.logout();
      } catch {
        try {
          client.close();
        } catch {}
      }
    }
  }

  for (const acct of microsoft) {
    // Phase D. Until Graph auth is wired, degrade gracefully — never block Gmail.
    markAuthBlocked(
      db,
      acct.address,
      "microsoft",
      "graph",
      "Microsoft/Graph ingestion not yet connected — see ACTION_REQUIRED.md (hard-stop #1)",
    );
  }

  console.log("\n" + formatCoverage(coverageReport(db)));
  db.close();
}

function cmdCoverage() {
  const db = openDb(paths.db);
  console.log(formatCoverage(coverageReport(db)));
  db.close();
}

function cmdSearch(flags) {
  const db = openDb(paths.db);
  const q = flags._[0];
  if (!q) {
    console.error('usage: search "<query>" [--account A]');
    process.exit(2);
  }
  const rows = ftsSearch(db, q, {
    account: flags.account || null,
    limit: Number(flags.limit) || 50,
  });
  for (const m of rows) {
    console.log(
      [
        new Date(m.date_utc).toISOString(),
        m.account,
        m.from_addr,
        m.subject,
      ].join("\t"),
    );
  }
  console.log(`\n${rows.length} hit(s)`);
  db.close();
}

function cmdFind(flags) {
  const db = openDb(paths.db);
  const opts = {
    account: flags.account || null,
    sender: flags.sender || null,
    subjectLike: flags.subject || null,
    tag: flags.tag || null,
    since: flags.since ? Date.parse(flags.since) : null,
    until: flags.until ? Date.parse(flags.until) : null,
    archived: flags.archived === true ? true : undefined,
    limit: Number(flags.limit) || 50,
  };
  const rows = findMessages(db, opts);
  for (const m of rows) {
    const tags = tagsOf(db, m.id).join(",");
    console.log(
      [
        m.id,
        new Date(m.date_utc).toISOString(),
        m.account,
        m.from_addr,
        m.subject,
        `[${tags}]`,
      ].join("\t"),
    );
  }
  console.log(`\n${rows.length} message(s)`);
  db.close();
}

function cmdGet(flags) {
  const db = openDb(paths.db);
  const id = Number(flags._[0]);
  const m = db.prepare("SELECT * FROM message WHERE id=?").get(id);
  if (!m) {
    console.error(`no message id ${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ...m, tags: tagsOf(db, id) }, null, 2));
  if (m.body_cached) {
    const body = getBody(db, paths.mail, id);
    if (body) console.log("\n--- body ---\n" + body.toString().slice(0, 4000));
  }
  db.close();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case "backfill":
      return cmdBackfill(flags._[0]);
    case "coverage":
      return cmdCoverage();
    case "search":
      return cmdSearch(flags);
    case "find":
      return cmdFind(flags);
    case "get":
      return cmdGet(flags);
    default:
      console.error(
        "usage: backfill [address] | coverage | search | find | get <id>",
      );
      process.exit(2);
  }
}

main().catch((err) => {
  logLine(`FATAL: ${err?.stack || err}`);
  process.exit(1);
});
