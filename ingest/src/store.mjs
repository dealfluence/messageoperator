/**
 * Write + read layer over the ingest DB. Everything here is idempotent:
 * messages upsert on (account, provider_msg_id), so re-running a backfill
 * never duplicates and never loses a stored body.
 */
import {
  writeMessage,
  readMessage,
  removeMessage,
  SENT_BOX,
  CACHE_BOX,
} from "./maildir.mjs";

const now = () => Date.now();

export function upsertAccount(db, address, provider) {
  db.prepare(
    "INSERT INTO account(address,provider) VALUES(?,?) " +
      "ON CONFLICT(address) DO UPDATE SET provider=excluded.provider",
  ).run(address, provider);
}

function addrsText(rec) {
  const parts = [];
  const push = (list) => {
    for (const a of list ?? []) {
      if (a?.name) parts.push(a.name);
      if (a?.address) parts.push(a.address);
    }
  };
  if (rec.fromName) parts.push(rec.fromName);
  if (rec.fromAddr) parts.push(rec.fromAddr);
  push(rec.to);
  push(rec.cc);
  push(rec.bcc);
  return parts.join(" ");
}

function setFts(db, id, { subject, addrs, body }) {
  db.prepare("DELETE FROM message_fts WHERE rowid=?").run(id);
  db.prepare(
    "INSERT INTO message_fts(rowid,subject,addrs,body) VALUES(?,?,?,?)",
  ).run(id, subject ?? "", addrs ?? "", body ?? "");
}

/**
 * Insert or update one message's metadata. Never touches body_cached/body_sha
 * (those belong to storeBody) and preserves any already-indexed FTS body.
 * Returns { id, inserted }.
 */
export function upsertMessage(db, rec) {
  const existing = db
    .prepare("SELECT id FROM message WHERE account=? AND provider_msg_id=?")
    .get(rec.account, rec.providerMsgId);

  const cols = [
    rec.account,
    rec.providerMsgId,
    rec.rfcMessageId ?? null,
    rec.threadId ?? null,
    rec.dateUtc ?? null,
    rec.fromAddr ?? null,
    rec.fromName ?? null,
    rec.subject ?? null,
    rec.size ?? null,
    rec.hasAttachment ? 1 : 0,
    rec.to ? JSON.stringify(rec.to) : null,
    rec.cc ? JSON.stringify(rec.cc) : null,
    rec.bcc ? JSON.stringify(rec.bcc) : null,
  ];

  let id;
  let inserted;
  if (existing) {
    id = existing.id;
    inserted = false;
    db.prepare(
      `UPDATE message SET rfc_message_id=?, thread_id=?, date_utc=?, from_addr=?,
        from_name=?, subject=?, size=?, has_attachment=?, to_json=?, cc_json=?, bcc_json=?
       WHERE id=?`,
    ).run(...cols.slice(2), id);
  } else {
    const info = db
      .prepare(
        `INSERT INTO message
          (account,provider_msg_id,rfc_message_id,thread_id,date_utc,from_addr,
           from_name,subject,size,has_attachment,to_json,cc_json,bcc_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(...cols);
    id = Number(info.lastInsertRowid);
    inserted = true;
  }

  // replace tags
  db.prepare("DELETE FROM tag WHERE message_id=?").run(id);
  const tagIns = db.prepare(
    "INSERT OR IGNORE INTO tag(message_id,tag) VALUES(?,?)",
  );
  for (const t of rec.tags ?? []) tagIns.run(id, t);

  // replace attachments
  db.prepare("DELETE FROM attachment WHERE message_id=?").run(id);
  const attIns = db.prepare(
    "INSERT INTO attachment(message_id,filename,mime,size) VALUES(?,?,?,?)",
  );
  for (const a of rec.attachments ?? [])
    attIns.run(id, a.filename ?? null, a.mime ?? null, a.size ?? null);

  // FTS: refresh subject+addrs, preserve any existing body text
  const prev = db.prepare("SELECT body FROM message_fts WHERE rowid=?").get(id);
  setFts(db, id, {
    subject: rec.subject,
    addrs: addrsText(rec),
    body: prev?.body ?? "",
  });

  return { id, inserted };
}

/**
 * Store a raw message body as a plain file in the account's Maildir and link
 * it to the message. kind 'sent' is pinned (never evicted); 'inbound' is
 * LRU-evictable. Idempotent by content (dedups within an account). Also
 * indexes the body text into FTS. `account` defaults to the message's account.
 */
export function storeBody(
  db,
  mailRoot,
  { messageId, account, raw, kind, bodyText },
) {
  const acct =
    account ??
    db.prepare("SELECT account FROM message WHERE id=?").get(messageId)
      ?.account;
  if (!acct)
    throw new Error(`storeBody: unknown account for message ${messageId}`);
  const flags = kind === "sent" ? "S" : "";
  const box = kind === "sent" ? SENT_BOX : CACHE_BOX;
  const { file, sha, size } = writeMessage(mailRoot, acct, raw, { flags, box });
  const pinned = kind === "sent" ? 1 : 0;
  db.prepare(
    `UPDATE message SET body_cached=1, maildir_file=?, content_sha=?, body_size=?,
       body_kind=?, body_pinned=?, body_last_access=? WHERE id=?`,
  ).run(file, sha, size, kind, pinned, now(), messageId);

  if (bodyText != null) {
    const cur = db
      .prepare("SELECT subject,addrs FROM message_fts WHERE rowid=?")
      .get(messageId);
    setFts(db, messageId, {
      subject: cur?.subject ?? "",
      addrs: cur?.addrs ?? "",
      body: bodyText,
    });
  }
  return sha;
}

/** Read a stored body from the Maildir, touching its LRU timestamp. null if absent. */
export function getBody(db, mailRoot, messageId) {
  const row = db
    .prepare("SELECT account, maildir_file FROM message WHERE id=?")
    .get(messageId);
  if (!row?.maildir_file) return null;
  const buf = readMessage(mailRoot, row.account, row.maildir_file);
  if (buf == null) return null;
  db.prepare("UPDATE message SET body_last_access=? WHERE id=?").run(
    now(),
    messageId,
  );
  return buf;
}

/** Evict least-recently-used INBOUND Maildir files until inbound bytes <= capBytes. */
export function enforceLru(db, mailRoot, capBytes) {
  const sumSql =
    "SELECT COALESCE(SUM(body_size),0) s FROM message WHERE body_cached=1 AND body_kind='inbound'";
  let total = db.prepare(sumSql).get().s;
  let evicted = 0;
  while (total > capBytes) {
    const victim = db
      .prepare(
        "SELECT id, account, maildir_file, body_size FROM message " +
          "WHERE body_cached=1 AND body_kind='inbound' AND body_pinned=0 " +
          "ORDER BY body_last_access ASC LIMIT 1",
      )
      .get();
    if (!victim) break;
    removeMessage(mailRoot, victim.account, victim.maildir_file);
    db.prepare(
      "UPDATE message SET body_cached=0, maildir_file=NULL, body_size=NULL, body_kind=NULL WHERE id=?",
    ).run(victim.id);
    // drop the now-orphaned FTS body, keep subject+addrs
    const cur = db
      .prepare("SELECT subject,addrs FROM message_fts WHERE rowid=?")
      .get(victim.id);
    setFts(db, victim.id, {
      subject: cur?.subject ?? "",
      addrs: cur?.addrs ?? "",
      body: "",
    });
    total -= victim.body_size || 0;
    evicted += 1;
  }
  return evicted;
}

/**
 * Structured message query used by validation + CLI. All filters optional:
 *   account, sender (substring on from_addr), since/until (epoch ms),
 *   archived (true ⇒ INBOX not in tags), tag (must have), subjectLike.
 */
export function findMessages(db, opts = {}) {
  const {
    account,
    sender,
    since,
    until,
    archived,
    tag,
    subjectLike,
    limit = 50,
  } = opts;
  const where = [];
  const params = [];
  if (account) {
    where.push("m.account=?");
    params.push(account);
  }
  if (sender) {
    where.push("m.from_addr LIKE ?");
    params.push(`%${sender}%`);
  }
  if (since != null) {
    where.push("m.date_utc>=?");
    params.push(since);
  }
  if (until != null) {
    where.push("m.date_utc<=?");
    params.push(until);
  }
  if (subjectLike) {
    where.push("m.subject LIKE ?");
    params.push(`%${subjectLike}%`);
  }
  if (tag) {
    where.push(
      "EXISTS (SELECT 1 FROM tag t WHERE t.message_id=m.id AND t.tag=?)",
    );
    params.push(tag);
  }
  if (archived === true) {
    where.push(
      "NOT EXISTS (SELECT 1 FROM tag t WHERE t.message_id=m.id AND t.tag='INBOX')",
    );
  } else if (archived === false) {
    where.push(
      "EXISTS (SELECT 1 FROM tag t WHERE t.message_id=m.id AND t.tag='INBOX')",
    );
  }
  const sql =
    "SELECT m.* FROM message m" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY m.date_utc DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/** Count archived (INBOX absent) messages for an account. */
export function countArchived(db, account) {
  return db
    .prepare(
      "SELECT COUNT(*) c FROM message m WHERE m.account=? AND " +
        "NOT EXISTS (SELECT 1 FROM tag t WHERE t.message_id=m.id AND t.tag='INBOX')",
    )
    .get(account).c;
}

/** Tags for a message id. */
export function tagsOf(db, id) {
  return db
    .prepare("SELECT tag FROM tag WHERE message_id=? ORDER BY tag")
    .all(id)
    .map((r) => r.tag);
}

/** FTS search. Returns message rows joined with rank, newest first on ties. */
export function search(db, query, { limit = 50, account = null } = {}) {
  const sql = `
    SELECT m.* FROM message_fts f
    JOIN message m ON m.id = f.rowid
    WHERE message_fts MATCH ?
    ${account ? "AND m.account = ?" : ""}
    ORDER BY rank, m.date_utc DESC
    LIMIT ?`;
  const params = account ? [query, account, limit] : [query, limit];
  return db.prepare(sql).all(...params);
}
