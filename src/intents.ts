/**
 * Outbound intent execution: the only path from the room to the network.
 *
 * The broker polls accounts/<addr>/mail/Outbox/new/ for `<draft>.intent.json`
 * files written by the in-room `mail send`. Every intent is validated (sha,
 * policy) and then delivered, simulated (dry_run), or rejected with
 * agent-readable feedback next to the returned draft.
 *
 * Live sends are fenced against duplicates: before touching the network the
 * intent is atomically renamed to `.intent.sending` (claimed), and
 * `send_executed` is ledgered immediately after delivery. If cleanup then
 * fails, the next cycle finds the claim, sees the ledger entry, and finishes
 * the cleanup instead of re-sending.
 */

import fs from "node:fs";
import path from "node:path";
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";

import type { AccountConfig, Config } from "./config.js";
import { findAccount, ownAddresses } from "./config.js";
import type { Layout } from "./layout.js";
import { sha12 } from "./layout.js";
import type { Index } from "./state.js";
import type { Ledger } from "./ledger.js";
import { log } from "./log.js";

const ORPHAN_DRAFT_AGE = 300; // seconds before an intent-less Outbox draft is returned

export class Rejection extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/** Delivery backends, keyed by provider; injected so tests can fake them. */
export interface Deliverers {
  gmail: (
    acct: AccountConfig,
    mime: Buffer,
    recipients: string[],
  ) => Promise<string>;
  microsoft: (
    acct: AccountConfig,
    mime: Buffer,
    recipients: string[],
  ) => Promise<string>;
}

/**
 * Draft backends, keyed by provider; injected so tests can fake them.
 * uploadDraft files a draft into the provider's own Drafts folder (never a
 * send); deleteDraft reversibly removes one (Trash / Deleted Items).
 */
export interface DraftUploaders {
  gmail: (acct: AccountConfig, mime: Buffer) => Promise<string>;
  microsoft: (acct: AccountConfig, mime: Buffer) => Promise<string>;
}
export interface DraftDeleters {
  gmail: (
    acct: AccountConfig,
    messageId: string,
  ) => Promise<"applied" | "noop">;
  microsoft: (
    acct: AccountConfig,
    messageId: string,
  ) => Promise<"applied" | "noop">;
}

/** One live delivery this cycle: the channel account and the Message-ID. */
export interface ExecutedSend {
  account: string;
  messageId: string;
}

export async function processOutboxes(
  layout: Layout,
  index: Index,
  ledger: Ledger,
  cfg: Config,
  explained: Set<string>,
  deliverers: Deliverers,
  // Recipient addresses that count as "your own" (always allowed). The
  // broker passes only AUTHENTICATED accounts here: the agent can register
  // addresses (`mail account add`), so a merely-configured address must not
  // widen the allowlist — an injected email could otherwise add an attacker
  // address and immediately mail to it. Defaults to all configured accounts
  // for direct/unit use.
  authenticatedOwn?: Set<string>,
): Promise<ExecutedSend[]> {
  const own = authenticatedOwn ?? ownAddresses(cfg);
  const executed: ExecutedSend[] = [];
  for (const address of layout.accountAddresses()) {
    const outboxNew = path.join(
      layout.accounts,
      address,
      "mail",
      "Outbox",
      "new",
    );
    if (!fs.existsSync(outboxNew)) continue;
    for (const claimed of listSorted(outboxNew, ".intent.sending")) {
      try {
        await recoverClaimed(
          layout,
          ledger,
          cfg,
          address,
          claimed,
          explained,
          deliverers,
        );
      } catch (err) {
        log.error(`recovery of ${path.basename(claimed)} failed: ${err}`);
      }
    }
    for (const intentPath of listSorted(outboxNew, ".intent.json")) {
      try {
        const send = await processIntent(
          layout,
          ledger,
          cfg,
          address,
          intentPath,
          explained,
          deliverers,
          own,
        );
        if (send) executed.push(send);
      } catch (err) {
        log.error(
          `intent ${path.basename(intentPath)} failed unexpectedly: ${err}`,
        );
      }
    }
    try {
      sweepOrphanDrafts(layout, ledger, address, outboxNew, explained);
    } catch (err) {
      log.error(`orphan sweep of ${outboxNew} failed: ${err}`);
    }
  }
  return executed;
}

function listSorted(dir: string, suffix: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(suffix))
    .sort()
    .map((n) => path.join(dir, n));
}

/**
 * A processed draft may have come from any Drafts subdir; explain all
 * candidate prior locations so the diff audit does not flag the move.
 */
function explainDraftLocations(
  explained: Set<string>,
  account: string,
  draftName: string,
): void {
  for (const sub of ["cur", "new", "tmp"]) {
    explained.add(`accounts/${account}/mail/Drafts/${sub}/${draftName}`);
  }
}

async function processIntent(
  layout: Layout,
  ledger: Ledger,
  cfg: Config,
  accountDirName: string,
  intentPath: string,
  explained: Set<string>,
  deliverers: Deliverers,
  own: Set<string>,
): Promise<ExecutedSend | null> {
  const draftName = path.basename(intentPath).replace(/\.intent\.json$/, "");
  const draftPath = path.join(path.dirname(intentPath), draftName);
  const acctMail = path.join(layout.accounts, accountDirName, "mail");

  let intent: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    intent = JSON.parse(fs.readFileSync(intentPath, "utf-8"));
  } catch (err) {
    parseError = String(err);
  }

  explained.add(layout.rel(intentPath));

  if (intent === null) {
    ledger.append("send_rejected", {
      reason: "bad_intent",
      intent: path.basename(intentPath),
      error: parseError,
    });
    returnDraft(
      layout,
      acctMail,
      draftPath,
      draftName,
      `intent file was unreadable: ${parseError}`,
      explained,
    );
    fs.rmSync(intentPath, { force: true });
    return null;
  }

  const shaExpected = String(intent.sha256_12 ?? "");
  const attachments: string[] = Array.isArray(intent.attachments)
    ? intent.attachments.map(String)
    : [];
  const intentAccount = String(intent.account ?? "");
  ledger.append(
    "send_intent",
    { account: intentAccount, draft: draftName, attachments },
    { actor: "agent", sha: shaExpected },
  );
  explainDraftLocations(explained, accountDirName, draftName);

  if (!fs.existsSync(draftPath)) {
    ledger.append(
      "send_rejected",
      { reason: "draft_missing", draft: draftName },
      { sha: shaExpected },
    );
    fs.rmSync(intentPath, { force: true });
    return null;
  }

  try {
    const raw = fs.readFileSync(draftPath);
    const shaActual = sha12(raw);
    if (shaActual !== shaExpected) {
      throw new Rejection(
        "sha_mismatch",
        `draft content changed after send was queued ` +
          `(expected ${shaExpected}, found ${shaActual}); re-run mail send`,
      );
    }
    const recipients = await checkPolicy(
      layout,
      ledger,
      cfg,
      raw,
      attachments,
      own,
    );
    const mime = finalMime(layout, raw, attachments);
    const acct = resolveChannel(cfg, intentAccount);

    if (cfg.dry_run) {
      ledger.append(
        "send_simulated",
        {
          account: intentAccount,
          channel: acct.provider,
          recipients,
          attachments,
          note: "dry_run = true in config; no network call was made",
        },
        { sha: shaActual },
      );
      finishSend(
        layout,
        acctMail,
        draftPath,
        draftName,
        intentPath,
        explained,
        mime,
      );
    } else {
      // claim the intent BEFORE the network call: if anything after
      // delivery fails, the next cycle must not re-send
      const claimed = path.join(
        path.dirname(intentPath),
        draftName + ".intent.sending",
      );
      fs.renameSync(intentPath, claimed);
      explained.add(layout.rel(claimed));
      let messageId: string;
      try {
        messageId = await deliverers[acct.provider](acct, mime, recipients);
      } catch (err) {
        fs.renameSync(claimed, intentPath); // nothing was sent; unclaim
        if (err instanceof Rejection) throw err;
        throw new Rejection("delivery_error", `delivery failed: ${err}`);
      }
      ledger.append(
        "send_executed",
        {
          account: intentAccount,
          channel: acct.provider,
          recipients,
          message_id: messageId,
          attachments,
        },
        { sha: shaActual },
      );
      finishSend(
        layout,
        acctMail,
        draftPath,
        draftName,
        claimed,
        explained,
        mime,
      );
      return { account: acct.address, messageId };
    }
  } catch (err) {
    if (!(err instanceof Rejection)) throw err;
    ledger.append(
      "send_rejected",
      { reason: err.reason, detail: err.detail, draft: draftName },
      { sha: shaExpected },
    );
    returnDraft(layout, acctMail, draftPath, draftName, err.detail, explained);
    fs.rmSync(intentPath, { force: true });
  }
  return null;
}

// ---- provider drafts (DraftBox) --------------------------------------
//
// A SEPARATE queue from Outbox so a draft can never be mistaken for a send.
// The room writes accounts/<addr>/mail/DraftBox/new/<name>.draft.json (and,
// for uploads, the sibling <name>.eml). Each intent carries an `op`:
//   upload — APPEND/create the .eml as a draft in the provider's Drafts;
//   delete — reversibly trash a provider draft by Message-ID (no .eml).
// A draft is never delivered to a third party, so there is no recipient
// allowlist check here (unlike sends): it only ever lands in the owner's own
// Drafts. Uploads are still sha-validated so the bytes the human reviewed are
// exactly the bytes filed.

const DRAFT_INTENT_SUFFIX = ".draft.json";

export async function processDraftBox(
  layout: Layout,
  ledger: Ledger,
  cfg: Config,
  explained: Set<string>,
  uploaders: DraftUploaders,
  deleters: DraftDeleters,
): Promise<void> {
  for (const address of layout.accountAddresses()) {
    const boxNew = path.join(
      layout.accounts,
      address,
      "mail",
      "DraftBox",
      "new",
    );
    if (!fs.existsSync(boxNew)) continue;
    for (const intentPath of listSorted(boxNew, DRAFT_INTENT_SUFFIX)) {
      try {
        await processDraftIntent(
          layout,
          ledger,
          cfg,
          address,
          intentPath,
          explained,
          uploaders,
          deleters,
        );
      } catch (err) {
        log.error(`draft intent ${path.basename(intentPath)} failed: ${err}`);
      }
    }
  }
}

async function processDraftIntent(
  layout: Layout,
  ledger: Ledger,
  cfg: Config,
  accountDirName: string,
  intentPath: string,
  explained: Set<string>,
  uploaders: DraftUploaders,
  deleters: DraftDeleters,
): Promise<void> {
  const baseName = path.basename(intentPath).replace(/\.draft\.json$/, "");
  const emlPath = path.join(path.dirname(intentPath), baseName);
  const acctMail = path.join(layout.accounts, accountDirName, "mail");
  explained.add(layout.rel(intentPath));

  let intent: Record<string, unknown> | null = null;
  let parseError = "";
  try {
    intent = JSON.parse(fs.readFileSync(intentPath, "utf-8"));
  } catch (err) {
    parseError = String(err);
  }
  if (!intent) {
    ledger.append("draft_rejected", {
      account: accountDirName,
      reason: "intent_unreadable",
      error: parseError,
    });
    fs.rmSync(intentPath, { force: true });
    return;
  }

  const intentAccount = String(intent.account ?? "");
  const op = String(intent.op ?? "");

  try {
    const acct = resolveChannel(cfg, intentAccount);

    if (op === "delete") {
      const messageId = String(intent.message_id ?? "").trim();
      if (!messageId) {
        throw new Rejection(
          "missing_message_id",
          "draft delete intent has no message_id",
        );
      }
      if (cfg.dry_run) {
        ledger.append(
          "draft_delete_simulated",
          {
            account: intentAccount,
            channel: acct.provider,
            message_id: messageId,
            note: "dry_run = true in config; no network call was made",
          },
          { actor: "agent" },
        );
        fs.rmSync(intentPath, { force: true });
        return;
      }
      const result = await deleters[acct.provider](acct, messageId);
      ledger.append(
        "draft_deleted",
        {
          account: intentAccount,
          channel: acct.provider,
          message_id: messageId,
          result,
        },
        { actor: "agent" },
      );
      fs.rmSync(intentPath, { force: true });
      return;
    }

    if (op === "upload") {
      explainDraftLocations(explained, accountDirName, baseName);
      explained.add(layout.rel(emlPath));
      if (!fs.existsSync(emlPath)) {
        throw new Rejection(
          "draft_missing",
          `draft body ${baseName} not found next to its intent`,
        );
      }
      const raw = fs.readFileSync(emlPath);
      const shaExpected = String(intent.sha256_12 ?? "");
      const shaActual = sha12(raw);
      if (shaExpected && shaActual !== shaExpected) {
        throw new Rejection(
          "sha_mismatch",
          `draft content changed after it was queued ` +
            `(expected ${shaExpected}, found ${shaActual}); re-run mail draft`,
        );
      }
      if (cfg.dry_run) {
        ledger.append(
          "draft_upload_simulated",
          {
            account: intentAccount,
            channel: acct.provider,
            note: "dry_run = true in config; no network call was made",
          },
          { sha: shaActual },
        );
        fs.rmSync(emlPath, { force: true });
        fs.rmSync(intentPath, { force: true });
        return;
      }
      const ref = await uploaders[acct.provider](acct, raw);
      ledger.append(
        "draft_uploaded",
        {
          account: intentAccount,
          channel: acct.provider,
          message_id: ref,
        },
        { sha: shaActual },
      );
      fs.rmSync(emlPath, { force: true });
      fs.rmSync(intentPath, { force: true });
      return;
    }

    throw new Rejection("unknown_op", `unknown draft op ${JSON.stringify(op)}`);
  } catch (err) {
    if (!(err instanceof Rejection)) throw err;
    ledger.append("draft_rejected", {
      account: intentAccount,
      reason: err.reason,
      detail: err.detail,
      draft: baseName,
    });
    // For a failed upload, hand the .eml back to Drafts so the human can fix
    // and retry; deletes have no body to return.
    if (op === "upload" && fs.existsSync(emlPath)) {
      returnDraftBody(
        layout,
        acctMail,
        emlPath,
        baseName,
        err.detail,
        explained,
      );
    }
    fs.rmSync(intentPath, { force: true });
  }
}

function returnDraftBody(
  layout: Layout,
  acctMail: string,
  emlPath: string,
  baseName: string,
  reasonText: string,
  explained: Set<string>,
): void {
  const drafts = path.join(acctMail, "Drafts", "cur");
  fs.mkdirSync(drafts, { recursive: true });
  const note = path.join(drafts, `${baseName}.rejected.txt`);
  fs.writeFileSync(
    note,
    "This draft upload was rejected by the broker.\n\n" +
      `Reason: ${reasonText}\n\n` +
      "The draft has been returned to Drafts/. Fix it and run mail draft again.\n",
  );
  explained.add(layout.rel(note));
  const returned = path.join(drafts, baseName);
  explained.add(layout.rel(returned));
  explained.add(layout.rel(emlPath));
  fs.renameSync(emlPath, returned);
}

function finishSend(
  layout: Layout,
  acctMail: string,
  draftPath: string,
  draftName: string,
  intentPath: string,
  explained: Set<string>,
  mime?: Buffer,
): void {
  const sentDir = path.join(acctMail, "Sent", "cur");
  fs.mkdirSync(sentDir, { recursive: true });
  const dest = path.join(sentDir, draftName);
  explained.add(layout.rel(dest));
  explained.add(layout.rel(draftPath));
  // The Sent copy should be what was actually sent — the attachment-folded
  // MIME, not the bare draft. finalMime() returns the raw bytes unchanged
  // when there are no attachments, so a plain message is byte-identical to
  // before. Write the mime, then drop the Outbox draft.
  if (mime) {
    fs.writeFileSync(dest, mime);
    fs.rmSync(draftPath, { force: true });
  } else {
    fs.renameSync(draftPath, dest);
  }
  fs.rmSync(intentPath, { force: true });
}

/** Resolve a `.intent.sending` file left by an interrupted live send. */
async function recoverClaimed(
  layout: Layout,
  ledger: Ledger,
  cfg: Config,
  accountDirName: string,
  claimed: string,
  explained: Set<string>,
  _deliverers: Deliverers,
): Promise<void> {
  const draftName = path.basename(claimed).replace(/\.intent\.sending$/, "");
  const draftPath = path.join(path.dirname(claimed), draftName);
  const acctMail = path.join(layout.accounts, accountDirName, "mail");
  let sha = "";
  try {
    sha = String(JSON.parse(fs.readFileSync(claimed, "utf-8")).sha256_12 ?? "");
  } catch {
    sha = "";
  }
  const executed =
    !!sha &&
    ledger.readAll().some((r) => r.op === "send_executed" && r.sha === sha);
  explained.add(layout.rel(claimed));
  explainDraftLocations(explained, accountDirName, draftName);
  if (executed) {
    // delivery happened; only the cleanup was interrupted
    log.info(`finishing interrupted send ${draftName}`);
    if (fs.existsSync(draftPath)) {
      finishSend(layout, acctMail, draftPath, draftName, claimed, explained);
    } else {
      fs.rmSync(claimed, { force: true });
    }
  } else {
    // interrupted before delivery: put the intent back in the queue
    log.info(`re-queueing unclaimed intent ${draftName}`);
    fs.renameSync(
      claimed,
      path.join(path.dirname(claimed), draftName + ".intent.json"),
    );
  }
}

/**
 * Return Outbox drafts whose intent never materialized (e.g. `mail send`
 * was killed between moving the draft and writing the intent).
 */
function sweepOrphanDrafts(
  layout: Layout,
  ledger: Ledger,
  account: string,
  outboxNew: string,
  explained: Set<string>,
): void {
  const now = Date.now() / 1000;
  for (const draft of listSorted(outboxNew, ".eml")) {
    if (fs.existsSync(draft + ".intent.json")) continue;
    if (fs.existsSync(draft + ".intent.sending")) continue;
    let age: number;
    try {
      age = now - fs.statSync(draft).mtimeMs / 1000;
    } catch {
      continue;
    }
    if (age < ORPHAN_DRAFT_AGE) continue; // a mail send may be mid-flight
    ledger.append("send_rejected", {
      reason: "intent_missing",
      draft: path.basename(draft),
      detail:
        "draft found in Outbox without an intent; mail send was interrupted",
    });
    const acctMail = path.join(layout.accounts, account, "mail");
    explainDraftLocations(explained, account, path.basename(draft));
    returnDraft(
      layout,
      acctMail,
      draft,
      path.basename(draft),
      "the draft was in the Outbox without a send intent " +
        "(mail send appears to have been interrupted); run mail send again",
      explained,
    );
  }
}

function returnDraft(
  layout: Layout,
  acctMail: string,
  draftPath: string,
  draftName: string,
  reasonText: string,
  explained: Set<string>,
): void {
  const drafts = path.join(acctMail, "Drafts", "cur");
  fs.mkdirSync(drafts, { recursive: true });
  const note = path.join(drafts, `${draftName}.rejected.txt`);
  fs.writeFileSync(
    note,
    "This send was rejected by the broker.\n\n" +
      `Reason: ${reasonText}\n\n` +
      "The draft has been returned to Drafts/. Fix it and run mail send again.\n",
  );
  explained.add(layout.rel(note));
  if (fs.existsSync(draftPath)) {
    const returned = path.join(drafts, draftName);
    explained.add(layout.rel(returned));
    explained.add(layout.rel(draftPath));
    fs.renameSync(draftPath, returned);
  }
}

function addressList(
  value: AddressObject | AddressObject[] | undefined,
): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((a) => a.value)
    .map((a) => (a.address || "").toLowerCase())
    .filter((a) => a.includes("@"));
}

async function checkPolicy(
  layout: Layout,
  ledger: Ledger,
  cfg: Config,
  raw: Buffer,
  attachments: string[],
  own: Set<string>,
): Promise<string[]> {
  const parsed: ParsedMail = await simpleParser(raw);

  // an SMTP client can derive the envelope from Resent-* headers,
  // bypassing whatever we validate below - refuse them outright.
  const resent = [
    ...new Set(
      parsed.headerLines
        .map((h) => h.key)
        .filter((k) => k.startsWith("resent-"))
        .map((k) => k.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase())),
    ),
  ].sort();
  if (resent.length) {
    throw new Rejection(
      "resent_headers_not_allowed",
      `draft contains ${resent.join(", ")}; Resent-* headers are not allowed`,
    );
  }

  const recipients = [
    ...addressList(parsed.to),
    ...addressList(parsed.cc),
    ...addressList(parsed.bcc),
  ];
  if (!recipients.length) {
    throw new Rejection(
      "no_recipients",
      "the draft has no parseable recipients",
    );
  }

  const allowedDomains = new Set(cfg.policy.allowed_recipient_domains);
  for (const rcpt of recipients) {
    const domain = rcpt.slice(rcpt.lastIndexOf("@") + 1);
    if (own.has(rcpt) || allowedDomains.has(domain)) continue;
    throw new Rejection(
      "recipient_not_allowed",
      `recipient ${rcpt} is outside the allowlist ` +
        `(allowed domains: ${allowedDomains.size ? [...allowedDomains].sort().join(", ") : "none"}; ` +
        "own addresses are always allowed)",
    );
  }

  const hourAgo = Date.now() - 3600_000;
  let sends = 0;
  for (const record of ledger.readAll()) {
    if (record.op !== "send_executed" && record.op !== "send_simulated")
      continue;
    const ts = Date.parse(record.ts);
    if (Number.isFinite(ts) && ts >= hourAgo) sends += 1;
  }
  if (sends >= cfg.policy.max_sends_per_hour) {
    throw new Rejection(
      "rate_limited",
      `${sends} sends in the last hour >= max_sends_per_hour ` +
        `(${cfg.policy.max_sends_per_hour}); wait and retry`,
    );
  }

  const maxBytes = cfg.policy.max_attachment_mb * 1024 * 1024;
  const room = path.resolve(layout.room);
  for (const att of attachments) {
    const attPath = path.resolve(layout.room, att);
    if (attPath !== room && !attPath.startsWith(room + path.sep)) {
      throw new Rejection(
        "attachment_outside_room",
        `attachment path escapes the room: ${att}`,
      );
    }
    const relParts = path.relative(room, attPath).split(path.sep);
    if (relParts[0] !== "attachments") {
      throw new Rejection(
        "attachment_outside_attachments_dir",
        `attachments must live under attachments/ (got ${att}); copy the file there first`,
      );
    }
    let size: number;
    try {
      size = fs.statSync(attPath).size;
    } catch {
      throw new Rejection("attachment_missing", `attachment not found: ${att}`);
    }
    if (size > maxBytes) {
      throw new Rejection(
        "attachment_too_large",
        `attachment ${att} is ${(size / 1024 / 1024).toFixed(1)} MB ` +
          `> max_attachment_mb (${cfg.policy.max_attachment_mb})`,
      );
    }
  }
  return recipients;
}

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".zip": "application/zip",
  ".json": "application/json",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * RFC 2045 token characters that need no quoting, minus the RFC 2231
 * `attribute-char` exclusions — safe to leave literal in a percent-encoded
 * parameter value.
 */
const PARAM_SAFE = /[A-Za-z0-9!#$&+\-.^_~]/;

/**
 * One MIME parameter (`name=`, `filename=`), encoded so the header line stays
 * US-ASCII as RFC 5322 requires.
 *
 * Plain ASCII values keep the historical quoted-string form byte for byte. A
 * value with non-ASCII (or with quoting hazards of its own) switches to the
 * RFC 2231 extended form, `filename*=utf-8''<percent-encoded UTF-8>`, which
 * Gmail, Outlook and every current MUA decode.
 *
 * This exists because the message is assembled as a JS string and written with
 * "latin1" (the byte-preserving round-trip the pass-through body relies on).
 * That encoding truncates each UTF-16 code unit to its low byte, so a literal
 * "Ä" shipped as the single byte 0xC4 and "☃" as 0x03 — a control character,
 * unrecoverable. Emitting pure ASCII here makes the latin1 write a no-op.
 */
function mimeParam(key: string, value: string): string {
  if (/^[\x20-\x7E]*$/.test(value) && !/["\\]/.test(value)) {
    return `${key}="${value}"`;
  }
  const encoded = [...Buffer.from(value, "utf-8")]
    .map((byte) => {
      const ch = String.fromCharCode(byte);
      return PARAM_SAFE.test(ch)
        ? ch
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  return `${key}*=utf-8''${encoded}`;
}

/**
 * Fold attachments into the draft by wrapping it in multipart/mixed. The
 * original header block and body bytes are preserved inside the wrap; a
 * draft without attachments is passed through untouched (exact bytes).
 */
export function finalMime(
  layout: Layout,
  raw: Buffer,
  attachments: string[],
): Buffer {
  if (!attachments.length) return raw;

  const text = raw.toString("latin1"); // byte-preserving split
  let split = text.indexOf("\r\n\r\n");
  let sepLen = 4;
  const lfSplit = text.indexOf("\n\n");
  if (split === -1 || (lfSplit !== -1 && lfSplit < split)) {
    split = lfSplit;
    sepLen = 2;
  }
  const headerText = split === -1 ? text : text.slice(0, split);
  const bodyText = split === -1 ? "" : text.slice(split + sepLen);

  // pull Content-* / MIME-Version headers (with continuations) out of the
  // top block; they describe the body, which becomes the first part
  const headerLines = headerText.split(/\r?\n/);
  const topHeaders: string[] = [];
  const bodyHeaders: string[] = [];
  let target = topHeaders;
  for (const line of headerLines) {
    if (!/^[ \t]/.test(line)) {
      target = /^(content-|mime-version)/i.test(line)
        ? bodyHeaders
        : topHeaders;
    }
    target.push(line);
  }
  const bodyPartHeaders = bodyHeaders.filter((l) => !/^mime-version/i.test(l));
  if (!bodyPartHeaders.some((l) => /^content-type/i.test(l))) {
    bodyPartHeaders.push('Content-Type: text/plain; charset="utf-8"');
  }

  const boundary = "messageoperator-" + sha12(raw);
  const out: string[] = [];
  out.push(...topHeaders);
  out.push("MIME-Version: 1.0");
  out.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  out.push("");
  out.push(`--${boundary}`);
  out.push(...bodyPartHeaders);
  out.push("");
  out.push(bodyText);
  for (const att of attachments) {
    const attPath = path.resolve(layout.room, att);
    let payload: Buffer;
    try {
      payload = fs.readFileSync(attPath);
    } catch (err) {
      throw new Rejection(
        "attachment_unreadable",
        `cannot read attachment ${att}: ${err}`,
      );
    }
    const name = path.basename(attPath);
    const ctype =
      MIME_TYPES[path.extname(name).toLowerCase()] ||
      "application/octet-stream";
    out.push(`--${boundary}`);
    out.push(`Content-Type: ${ctype}; ${mimeParam("name", name)}`);
    out.push("Content-Transfer-Encoding: base64");
    out.push(`Content-Disposition: attachment; ${mimeParam("filename", name)}`);
    out.push("");
    out.push(payload.toString("base64").replace(/(.{76})/g, "$1\r\n"));
  }
  out.push(`--${boundary}--`);
  out.push("");
  return Buffer.from(out.join("\r\n"), "latin1");
}

function resolveChannel(cfg: Config, account: string): AccountConfig {
  const acct = account ? findAccount(cfg, account) : undefined;
  if (!acct) {
    throw new Rejection(
      "unknown_account",
      `intent account ${JSON.stringify(account)} matches no configured account`,
    );
  }
  return acct;
}

/** The exact sha-validated bytes with SMTP CRLF line endings. */
export function toWire(mime: Buffer): Buffer {
  return Buffer.from(
    mime.toString("latin1").replace(/(?<!\r)\n/g, "\r\n"),
    "latin1",
  );
}
