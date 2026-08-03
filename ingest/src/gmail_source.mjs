/**
 * Gmail acquisition over IMAP: a single read-only ascending-UID scan of
 * [Gmail]/All Mail. All Mail holds exactly one physical copy of every message
 * with its full label set, so one pass yields complete coverage + the
 * many-to-many tags. Metadata-only for the backfill; SENT messages also get
 * their full body fetched, stored, and FTS-indexed.
 *
 * Resumable: a per-(account, mailbox) UIDVALIDITY:last_uid watermark is
 * committed with each batch inside one transaction, so killing mid-run rolls
 * back the open batch and restart resumes at last_uid+1 — no re-fetch.
 *
 * READ-ONLY: every mailbox is opened { readOnly: true }; never STORE/MOVE/
 * COPY/EXPUNGE. The client is injectable so tests drive a fake and real runs
 * use imapflow unchanged.
 */
import { gmailLabelsToTags } from "./tags.mjs";
import { upsertAccount, upsertMessage, storeBody } from "./store.mjs";

const now = () => Date.now();

/** Collect attachment parts {filename, mime, size} from an imapflow bodyStructure. */
export function attachmentsFromStructure(node, out = []) {
  if (!node) return out;
  const disp = (node.disposition || "").toLowerCase();
  const filename =
    node.dispositionParameters?.filename ||
    node.parameters?.name ||
    node.dispositionParameters?.name ||
    null;
  if (
    disp === "attachment" ||
    (filename && disp !== "inline" && !node.childNodes)
  ) {
    out.push({
      filename: filename || null,
      mime: node.type
        ? `${node.type}${node.subtype ? "/" + node.subtype : ""}`
        : null,
      size: node.size ?? null,
    });
  }
  for (const child of node.childNodes ?? [])
    attachmentsFromStructure(child, out);
  return out;
}

/** Build a provider-neutral message record from one imapflow fetch result. */
export function recordFromFetch(account, msg) {
  const env = msg.envelope ?? {};
  const labels = msg.labels ? [...msg.labels] : [];
  const tags = gmailLabelsToTags(labels);
  const atts = attachmentsFromStructure(msg.bodyStructure);
  const mapAddrs = (list) =>
    (list ?? []).map((a) => ({
      name: a.name || null,
      address: a.address || null,
    }));
  const dateUtc =
    msg.internalDate instanceof Date
      ? msg.internalDate.getTime()
      : env.date instanceof Date
        ? env.date.getTime()
        : null;
  return {
    account,
    providerMsgId: msg.emailId ? String(msg.emailId) : `uid:${msg.uid}`,
    rfcMessageId: env.messageId ?? null,
    threadId: msg.threadId ? String(msg.threadId) : null,
    dateUtc,
    fromAddr: env.from?.[0]?.address ?? null,
    fromName: env.from?.[0]?.name ?? null,
    subject: env.subject ?? null,
    size: msg.size ?? null,
    hasAttachment: atts.length > 0,
    to: mapAddrs(env.to),
    cc: mapAddrs(env.cc),
    bcc: mapAddrs(env.bcc),
    tags: [...tags],
    attachments: atts,
    _uid: msg.uid,
    _isSent: tags.has("SENT"),
  };
}

const METADATA_FIELDS = {
  uid: true,
  envelope: true,
  internalDate: true,
  size: true,
  flags: true,
  labels: true,
  emailId: true,
  threadId: true,
  bodyStructure: true,
};

function readWatermark(db, account, mailbox) {
  const row = db
    .prepare(
      "SELECT uid_validity, last_uid FROM sync_state WHERE account=? AND mailbox=?",
    )
    .get(account, mailbox);
  return row ?? { uid_validity: null, last_uid: 0 };
}

function writeWatermark(
  db,
  account,
  mailbox,
  { uidValidity, lastUid, status, totalExpected },
) {
  db.prepare(
    `INSERT INTO sync_state(account,mailbox,uid_validity,last_uid,status,total_expected,updated_utc)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(account,mailbox) DO UPDATE SET
       uid_validity=excluded.uid_validity, last_uid=excluded.last_uid,
       status=excluded.status, total_expected=COALESCE(excluded.total_expected, sync_state.total_expected),
       updated_utc=excluded.updated_utc`,
  ).run(
    account,
    mailbox,
    uidValidity ?? null,
    lastUid,
    status ?? null,
    totalExpected ?? null,
    now(),
  );
}

async function findAllMailbox(client) {
  try {
    const entries = await client.list();
    const all = entries.find((e) => e.specialUse === "\\All")?.path;
    if (all) return all;
  } catch {
    /* fall through */
  }
  return "[Gmail]/All Mail";
}

/**
 * Backfill (and incrementally top up) one Gmail account from All Mail.
 * opts: { account, client, batchSize=500, sentBodies=true, parseBody, log,
 *         onBatch }  (parseBody(raw)->Promise<string> extracts FTS text)
 * Returns { stored, scanned, lastUid, uidValidity, allPath }.
 */
export async function backfillAllMail(db, mailRoot, opts) {
  const {
    account,
    client,
    batchSize = 500,
    sentBodies = true,
    parseBody = null,
    log = () => {},
    onBatch = null,
  } = opts;
  upsertAccount(db, account, "gmail");
  const allPath = await findAllMailbox(client);

  const wm = readWatermark(db, account, allPath);
  const box = await client.mailboxOpen(allPath, { readOnly: true });
  const uidValidity = Number(box.uidValidity ?? 0);
  const exists = box.exists ?? null;

  let lastUid = Number(wm.last_uid || 0);
  if (wm.uid_validity != null && Number(wm.uid_validity) !== uidValidity) {
    log(
      `uidvalidity changed (${wm.uid_validity}->${uidValidity}); full re-scan`,
    );
    lastUid = 0;
  }
  writeWatermark(db, account, allPath, {
    uidValidity,
    lastUid,
    status: "in_progress",
    totalExpected: exists,
  });

  const range = `${lastUid + 1}:*`;
  const found = (await client.search({ uid: range }, { uid: true })) || [];
  const uids = found.filter((u) => u > lastUid).sort((a, b) => a - b);

  let stored = 0;
  let scanned = 0;
  for (let i = 0; i < uids.length; i += batchSize) {
    const chunk = uids.slice(i, i + batchSize);
    const records = [];
    for await (const msg of client.fetch(chunk, METADATA_FIELDS, {
      uid: true,
    })) {
      records.push(recordFromFetch(account, msg));
    }

    // fetch bodies for SENT messages in this batch (small, high value)
    const sentByUid = new Map();
    if (sentBodies) {
      const sentUids = records.filter((r) => r._isSent).map((r) => r._uid);
      if (sentUids.length) {
        for await (const m of client.fetch(
          sentUids,
          { uid: true, source: true },
          { uid: true },
        )) {
          if (m.source) sentByUid.set(m.uid, m.source);
        }
      }
    }

    db.exec("BEGIN");
    try {
      for (const rec of records) {
        const { id } = upsertMessage(db, rec);
        scanned += 1;
        stored += 1;
        const src = sentByUid.get(rec._uid);
        if (src) {
          let bodyText = null;
          if (parseBody) {
            try {
              bodyText = await parseBody(src);
            } catch {
              bodyText = null;
            }
          }
          storeBody(db, mailRoot, {
            messageId: id,
            account: rec.account,
            raw: src,
            kind: "sent",
            bodyText,
          });
        }
      }
      const batchMaxUid = chunk[chunk.length - 1];
      lastUid = Math.max(lastUid, batchMaxUid);
      writeWatermark(db, account, allPath, {
        uidValidity,
        lastUid,
        status: "in_progress",
        totalExpected: exists,
      });
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    log(
      `batch ${i / batchSize + 1}: +${records.length} (uid<=${lastUid}), total ${stored}`,
    );
    if (onBatch) onBatch({ stored, scanned, lastUid });
  }

  writeWatermark(db, account, allPath, {
    uidValidity,
    lastUid,
    status: "caught_up",
    totalExpected: exists,
  });
  return { stored, scanned, lastUid, uidValidity, allPath };
}
