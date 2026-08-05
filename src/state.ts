/**
 * Message index + tags + sync state, now on SQLite (broker/store.db).
 *
 * Replaces the POC2 JSON map (broker/index.json): a 100k-message mailbox
 * cannot live in a linearly-scanned JSON blob that is reloaded per process.
 * The broker remains the only writer. WAL mode lets the in-room `mail` CLI
 * read the store concurrently without ever seeing a torn state.
 *
 * Compatibility: an existing POC2 broker/index.json is imported once into
 * an empty store; from then on the store owns the data and the in-room
 * `mail` CLI reads it directly (read-only).
 */

import fs from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";

import { hasFts, openDb } from "./db.js";
import { log } from "./log.js";

export interface MessageRow {
  sha: string;
  account: string;
  folder: string;
  filename: string;
  path: string;
  date: string;
  epoch: number;
  from: string;
  to: string;
  subject: string;
  body: string;
  /**
   * Provider-neutral label/tag set (Gmail X-GM-LABELS mapped). Present on
   * All-Mail rows so the room can answer "archived?" = INBOX not in labels.
   * Optional for backward compatibility with rows written before this field.
   */
  labels?: string[];
  /**
   * Provider message id (Gmail X-GM-MSGID / Graph message id). On
   * metadata-only rows it lets the broker fetch the full body on demand;
   * on full-body rows it dedups against the metadata backfill. (Named for
   * its Gmail origin; Graph ids ride in the same field.)
   */
  gmailId?: string;
  /** RFC 2822 Message-ID header, for cross-keying dedup. */
  rfcMessageId?: string;
  /** true when only metadata is indexed (no .eml body stored yet). */
  metaOnly?: boolean;
}

/** Structured, resumable per-mailbox sync progress (historical backfill). */
export interface SyncStateRow {
  account: string;
  mailbox: string;
  uidValidity: number | null;
  /** high-water mark: everything above it is new since the last scan */
  lastUid: number;
  /** backfill floor: history above lowUid is indexed; 0 = fully backfilled */
  lowUid: number;
  /** opaque provider cursor (Graph nextLink) */
  cursor: string | null;
  status: "not_started" | "in_progress" | "caught_up";
  totalExpected: number | null;
}

interface StateFile {
  version: number;
  messages: Record<string, MessageRow>;
  tags: Record<string, Record<string, string | null>>;
  graphSeen: string[];
  syncState: Record<string, string>;
}

const LEGACY_VERSION = 1;
const IMPORT_FLAG = "imported_legacy_json";

/**
 * Folders a message can legitimately be moved between when the room catches up
 * with the provider. Everything else — notably the `.Cache` maildir that holds
 * on-demand bodies, plus Drafts/Outbox, which the room owns — must never be
 * touched by drift correction.
 */
const SYNCABLE_FOLDERS = new Set(["INBOX", "Archive", "Sent"]);

/** Implicit-AND/OR FTS5 query: each whitespace-separated term quoted, except exact uppercase OR. */
export function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t === "OR" ? "OR" : `"${t.replace(/"/g, '""')}"`))
    .join(" ");
}

interface Statements {
  hasSha: StatementSync;
  hasProvider: StatementSync;
  hasRfc: StatementSync;
  insert: StatementSync;
  relocate: StatementSync;
  refreshLabels: StatementSync;
  addTag: StatementSync;
  removeTag: StatementSync;
  tagsOf: StatementSync;
  graphSeen: StatementSync;
  graphMark: StatementSync;
  getState: StatementSync;
  setState: StatementSync;
  getSync: StatementSync;
  putSync: StatementSync;
}

/** FTS-index statements; null when this runtime/store has no FTS5. */
interface FtsStatements {
  insert: StatementSync;
  del: StatementSync;
}

export class Index {
  private readonly db: DatabaseSync;
  private readonly legacyJson?: string;
  private readonly stmt: Statements;
  private readonly fts: FtsStatements | null;
  private dirty = false;
  private closed = false;

  constructor(dbPath: string, opts: { legacyJson?: string } = {}) {
    this.db = openDb(dbPath);
    this.legacyJson = opts.legacyJson;
    this.fts = this.prepareFts();
    this.stmt = {
      hasSha: this.db.prepare("SELECT 1 FROM message WHERE sha=?"),
      hasProvider: this.db.prepare(
        "SELECT 1 FROM message WHERE account=? AND provider_msg_id=?",
      ),
      hasRfc: this.db.prepare(
        "SELECT 1 FROM message WHERE account=? AND rfc_message_id=?",
      ),
      insert: this.db.prepare(
        `INSERT OR IGNORE INTO message
           (sha, account, folder, filename, path, date_text, epoch, from_text,
            to_text, subject, body_text, labels_json, provider_msg_id,
            rfc_message_id, meta_only)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ),
      relocate: this.db.prepare(
        "UPDATE message SET folder=?, path=?, filename=? WHERE sha=?",
      ),
      refreshLabels: this.db.prepare(
        "UPDATE message SET labels_json=? WHERE sha=? AND " +
          "IFNULL(labels_json,'') != IFNULL(?,'')",
      ),
      addTag: this.db.prepare(
        "INSERT OR IGNORE INTO tag (sha, tag, ts) VALUES (?,?,?)",
      ),
      removeTag: this.db.prepare("DELETE FROM tag WHERE sha=? AND tag=?"),
      tagsOf: this.db.prepare("SELECT tag FROM tag WHERE sha=? ORDER BY tag"),
      graphSeen: this.db.prepare("SELECT 1 FROM graph_seen WHERE id=?"),
      graphMark: this.db.prepare(
        "INSERT OR IGNORE INTO graph_seen (id, account) VALUES (?,?)",
      ),
      getState: this.db.prepare("SELECT value FROM kv_state WHERE key=?"),
      setState: this.db.prepare(
        "INSERT INTO kv_state (key, value) VALUES (?,?) " +
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ),
      getSync: this.db.prepare(
        "SELECT * FROM sync_state WHERE account=? AND mailbox=?",
      ),
      putSync: this.db.prepare(
        `INSERT INTO sync_state
           (account, mailbox, uid_validity, last_uid, low_uid, cursor, status,
            total_expected, updated_utc)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(account, mailbox) DO UPDATE SET
           uid_validity=excluded.uid_validity, last_uid=excluded.last_uid,
           low_uid=excluded.low_uid, cursor=excluded.cursor,
           status=excluded.status, total_expected=excluded.total_expected,
           updated_utc=excluded.updated_utc`,
      ),
    };
    this.importLegacyJson();
  }

  /**
   * FTS statements, or null when the store has no FTS index (runtime
   * without the fts5 module, or MESSAGEOPERATOR_DISABLE_FTS5). Search then scans
   * with LIKE; all data lives in the message table either way.
   */
  private prepareFts(): FtsStatements | null {
    if (!hasFts(this.db)) return null;
    try {
      return {
        insert: this.db.prepare(
          "INSERT INTO message_fts (rowid, subject, addrs, body) VALUES (?,?,?,?)",
        ),
        del: this.db.prepare("DELETE FROM message_fts WHERE rowid=?"),
      };
    } catch (err) {
      log.warn(`FTS index unusable in this runtime (${err}); using LIKE scans`);
      return null;
    }
  }

  /**
   * Run `fn` inside one SQLite transaction. Bulk insert paths (the sync
   * backfill chunks) use this to turn N-per-row commits into one commit —
   * measured ~20-30x higher insert throughput — and to make "rows + their
   * watermark" atomic. `fn` must be synchronous: holding a write
   * transaction across an await would pin the WAL for the duration.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back (e.g. the connection errored) */
      }
      throw err;
    }
  }

  /** Refresh (or drop) one message's FTS row; no-op without FTS. */
  private ftsUpsert(
    id: number,
    subject: string,
    addrs: string,
    body: string,
  ): void {
    if (!this.fts) return;
    this.fts.del.run(id);
    this.fts.insert.run(id, subject, addrs, body);
  }

  /**
   * One-time import of the POC2 broker/index.json into an empty store. The
   * flag is written even when there is nothing to import, so the legacy view
   * emitted by flush() is never mistaken for fresh input on the next open.
   */
  private importLegacyJson(): void {
    const flagged = this.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get(IMPORT_FLAG);
    if (flagged) return;
    const done = (): void => {
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, '1') " +
            "ON CONFLICT(key) DO UPDATE SET value='1'",
        )
        .run(IMPORT_FLAG);
    };
    let data: StateFile | null = null;
    try {
      data = JSON.parse(
        fs.readFileSync(this.legacyJson ?? "", "utf-8"),
      ) as StateFile;
    } catch {
      data = null;
    }
    if (!data || data.version !== LEGACY_VERSION) {
      done();
      return;
    }
    this.db.exec("BEGIN");
    try {
      for (const row of Object.values(data.messages ?? {})) {
        this.insertMessageRow(row);
      }
      for (const [sha, tags] of Object.entries(data.tags ?? {})) {
        for (const [tag, ts] of Object.entries(tags)) {
          this.stmt.addTag.run(sha, tag, ts);
        }
      }
      for (const id of data.graphSeen ?? []) {
        // legacy index.json carried no account; "" = unattributable
        this.stmt.graphMark.run(id, "");
      }
      for (const [key, value] of Object.entries(data.syncState ?? {})) {
        this.stmt.setState.run(key, value);
      }
      this.db.exec("COMMIT");
      log.info(
        `imported legacy index.json (${Object.keys(data.messages ?? {}).length} messages) into store.db`,
      );
    } catch (err) {
      this.db.exec("ROLLBACK");
      log.error(`legacy index.json import failed; starting empty: ${err}`);
    }
    done();
  }

  /**
   * SQLite commits every write immediately; flush() remains as a WAL
   * checkpoint hint at cycle end so the read-only `mail` CLI never faces an
   * unboundedly long -wal file. (POC2's index.json emission lived here; the
   * CLI reads store.db directly now, so the legacy view is gone.)
   */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {
      /* a reader holds the WAL; the next flush retries */
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.db.close();
  }

  hasSha(sha: string): boolean {
    return this.stmt.hasSha.get(sha) !== undefined;
  }

  /** true when a row with this provider message id exists for the account. */
  hasProviderMsg(account: string, providerMsgId: string): boolean {
    return this.stmt.hasProvider.get(account, providerMsgId) !== undefined;
  }

  /** true when a row with this RFC Message-ID exists for the account. */
  hasRfcMessageId(account: string, rfcMessageId: string): boolean {
    return this.stmt.hasRfc.get(account, rfcMessageId) !== undefined;
  }

  /**
   * Point an existing row at the folder the PROVIDER now reports, and return
   * what changed (null when it already agreed, or there is no such row).
   *
   * Sync skips messages it has already indexed, so a message archived or
   * un-archived OUTSIDE Message Operator — in Gmail's web UI, by a filter, on a phone —
   * kept whatever folder it had when first seen, forever. The provider is the
   * authority on folder state, so this re-homes the row toward it. The .eml on
   * disk is moved separately by the broker (see reconcileLocalFolders), which
   * is what owns file layout and the audit.
   */
  reconcileFolder(
    account: string,
    providerMsgId: string,
    folder: string,
    labels?: string[],
  ): { sha: string; from: string; to: string; path: string } | null {
    const row = this.db
      .prepare(
        "SELECT sha, folder, path FROM message WHERE account=? AND provider_msg_id=?",
      )
      .get(account, providerMsgId) as
      { sha: string; folder: string; path: string } | undefined;
    if (!row || row.folder === folder) return null;
    this.db
      .prepare("UPDATE message SET folder=?, labels_json=? WHERE sha=?")
      .run(folder, labels ? JSON.stringify(labels) : null, row.sha);
    this.dirty = true;
    return {
      sha: row.sha,
      from: row.folder,
      to: folder,
      path: row.path ?? "",
    };
  }

  /**
   * Rows whose stored path sits in a different folder than the row claims —
   * the index was re-homed by reconcileFolder but the file has not caught up.
   *
   * Restricted to moves BETWEEN syncable folders on purpose. Metadata-only rows
   * have no file to move, and a path/folder mismatch is legitimate elsewhere:
   * an on-demand body lives in the per-account `.Cache` maildir while its row
   * keeps the logical folder, so a naive mismatch check drags every cached body
   * out of the cache and defeats the LRU entirely.
   */
  rowsWithMisplacedFiles(): {
    sha: string;
    account: string;
    folder: string;
    path: string;
  }[] {
    return this.db
      .prepare(
        "SELECT sha, account, folder, path FROM message " +
          "WHERE path <> '' AND folder <> ''",
      )
      .all()
      .map(
        (r) =>
          r as { sha: string; account: string; folder: string; path: string },
      )
      .filter((r) => {
        const onDisk = folderOfRoomPath(r.path);
        return (
          onDisk !== r.folder &&
          SYNCABLE_FOLDERS.has(onDisk) &&
          SYNCABLE_FOLDERS.has(r.folder)
        );
      });
  }

  /**
   * Drop a metadata-only stand-in row so a full-body row can supersede it
   * (e.g. an archived message brought back to the inbox and folder-synced).
   * Full rows are never deleted. true if a row was removed.
   */
  deleteMetaOnlyByProvider(account: string, providerMsgId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM message WHERE account=? AND provider_msg_id=? AND meta_only=1",
      )
      .get(account, providerMsgId) as { id: number } | undefined;
    if (!row) return false;
    this.fts?.del.run(row.id);
    this.db.prepare("DELETE FROM message WHERE id=?").run(row.id);
    this.dirty = true;
    return true;
  }

  /** The full row for a sha, or null. */
  getBySha(sha: string): MessageRow | null {
    const r = this.db.prepare("SELECT * FROM message WHERE sha=?").get(sha) as
      Record<string, unknown> | undefined;
    return r ? toMessageRow(r) : null;
  }

  /**
   * Record a fetched-on-demand body: the row leaves metadata-only state,
   * points at its cached .eml, and its text becomes searchable. false when
   * the sha is unknown.
   */
  attachFetchedBody(
    sha: string,
    info: {
      path: string;
      filename: string;
      maildirFile: string;
      bodySize: number;
      bodyText: string;
      kind?: "inbound" | "sent";
      now?: number;
    },
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT id, subject, from_text, to_text FROM message WHERE sha=?",
      )
      .get(sha) as
      | { id: number; subject: string; from_text: string; to_text: string }
      | undefined;
    if (!row) return false;
    this.db
      .prepare(
        `UPDATE message SET path=?, filename=?, meta_only=0, body_cached=1,
           body_text=?, maildir_file=?, body_size=?, body_kind=?,
           body_pinned=0, body_last_access=? WHERE id=?`,
      )
      .run(
        info.path,
        info.filename,
        info.bodyText,
        info.maildirFile,
        info.bodySize,
        info.kind ?? "inbound",
        info.now ?? Date.now(),
        row.id,
      );
    this.ftsUpsert(
      row.id,
      row.subject,
      `${row.from_text} ${row.to_text}`,
      info.bodyText,
    );
    this.dirty = true;
    return true;
  }

  /**
   * LRU eviction bookkeeping: back to metadata-only, body text dropped from
   * the search index. File deletion is the caller's job. false = no cached
   * body to evict.
   */
  evictBody(sha: string): boolean {
    const row = this.db
      .prepare(
        "SELECT id, subject, from_text, to_text FROM message WHERE sha=? AND body_cached=1",
      )
      .get(sha) as
      | { id: number; subject: string; from_text: string; to_text: string }
      | undefined;
    if (!row) return false;
    this.db
      .prepare(
        `UPDATE message SET path='', filename='', meta_only=1, body_cached=0,
           body_text='', maildir_file=NULL, body_size=NULL, body_kind=NULL,
           body_last_access=NULL WHERE id=?`,
      )
      .run(row.id);
    this.ftsUpsert(row.id, row.subject, `${row.from_text} ${row.to_text}`, "");
    this.dirty = true;
    return true;
  }

  /** Refresh a cached body's LRU timestamp (a read touched it). */
  touchBody(sha: string, now: number = Date.now()): void {
    this.db
      .prepare(
        "UPDATE message SET body_last_access=? WHERE sha=? AND body_cached=1",
      )
      .run(now, sha);
  }

  /** Exempt a cached body from LRU eviction. */
  pinBody(sha: string): void {
    const info = this.db
      .prepare("UPDATE message SET body_pinned=1 WHERE sha=? AND body_cached=1")
      .run(sha);
    if (Number(info.changes) > 0) this.dirty = true;
  }

  /** Bytes of evictable (inbound, unpinned) cached bodies. */
  inboundCacheBytes(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(body_size), 0) AS s FROM message
          WHERE body_cached=1 AND body_kind='inbound' AND body_pinned=0`,
      )
      .get() as { s: number };
    return Number(row.s);
  }

  /** Evictable cached bodies, least recently used first. */
  lruVictims(): Array<{
    sha: string;
    account: string;
    path: string;
    bodySize: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT sha, account, path, body_size FROM message
          WHERE body_cached=1 AND body_kind='inbound' AND body_pinned=0
          ORDER BY body_last_access ASC`,
      )
      .all() as Array<{
      sha: string;
      account: string;
      path: string;
      body_size: number | null;
    }>;
    return rows.map((r) => ({
      sha: r.sha,
      account: r.account,
      path: r.path,
      bodySize: Number(r.body_size ?? 0),
    }));
  }

  getSyncState(account: string, mailbox: string): SyncStateRow | null {
    const r = this.stmt.getSync.get(account, mailbox) as
      Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      account: String(r.account),
      mailbox: String(r.mailbox),
      uidValidity: r.uid_validity == null ? null : Number(r.uid_validity),
      lastUid: Number(r.last_uid),
      lowUid: Number(r.low_uid),
      cursor: r.cursor == null ? null : String(r.cursor),
      status: String(r.status) as SyncStateRow["status"],
      totalExpected: r.total_expected == null ? null : Number(r.total_expected),
    };
  }

  putSyncState(row: SyncStateRow): void {
    this.stmt.putSync.run(
      row.account,
      row.mailbox,
      row.uidValidity,
      row.lastUid,
      row.lowUid,
      row.cursor,
      row.status,
      row.totalExpected,
      Date.now(),
    );
    this.dirty = true;
  }

  insertMessage(row: MessageRow): void {
    if (this.insertMessageRow(row)) this.dirty = true;
  }

  private insertMessageRow(row: MessageRow): boolean {
    const labelsJson = row.labels ? JSON.stringify(row.labels) : null;
    const info = this.stmt.insert.run(
      row.sha,
      row.account,
      row.folder,
      row.filename,
      row.path,
      row.date,
      row.epoch,
      row.from,
      row.to,
      row.subject,
      row.body,
      labelsJson,
      row.gmailId ?? null,
      row.rfcMessageId ?? null,
      row.metaOnly ? 1 : 0,
    );
    // Already indexed: the immutable content is unchanged (sha IS the content),
    // but labels are provider STATE and move under us — starring, archiving or
    // re-filing a message we already hold must be picked up rather than
    // discarded by INSERT OR IGNORE. Only refresh when this caller actually
    // carried a label set; a body fetch that knows nothing about labels must
    // not erase them. QA 2026-07-24, item 7.
    if (!info || Number(info.changes) === 0) {
      if (labelsJson === null) return false;
      const updated = this.stmt.refreshLabels.run(
        labelsJson,
        row.sha,
        labelsJson,
      );
      return Boolean(updated && Number(updated.changes) > 0);
    }
    this.ftsUpsert(
      Number(info.lastInsertRowid),
      row.subject,
      `${row.from} ${row.to}`,
      row.body,
    );
    return true;
  }

  allMessages(): MessageRow[] {
    const rows = this.db.prepare("SELECT * FROM message").all() as Array<
      Record<string, unknown>
    >;
    return rows.map(toMessageRow);
  }

  /**
   * shas of search matches (subject, addresses, body text), best first.
   * FTS5 when available; otherwise an implicit-AND LIKE scan over the same
   * columns — slower, never wrong.
   */
  searchShas(query: string, limit = 100): string[] {
    if (this.fts) {
      const match = ftsQuery(query);
      if (!match) return [];
      try {
        const rows = this.db
          .prepare(
            `SELECT m.sha FROM message_fts f JOIN message m ON m.id = f.rowid
              WHERE message_fts MATCH ? ORDER BY rank, m.epoch DESC LIMIT ?`,
          )
          .all(match, limit) as Array<{ sha: string }>;
        return rows.map((r) => r.sha);
      } catch {
        /* malformed MATCH or runtime hiccup: fall through to LIKE */
      }
    }
    const terms = query.split(/\s+/).filter(Boolean);
    if (!terms.length) return [];

    // Split terms by exact uppercase "OR" token into groups of AND terms
    const groups: string[][] = [];
    let currentGroup: string[] = [];
    for (const t of terms) {
      if (t === "OR") {
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
          currentGroup = [];
        }
      } else {
        currentGroup.push(t);
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    if (!groups.length) return [];

    const groupClauses: string[] = [];
    const params: string[] = [];
    const colExpr =
      "(subject || ' ' || from_text || ' ' || to_text || ' ' || body_text)";

    for (const group of groups) {
      const andClauses = group.map(() => `${colExpr} LIKE ? ESCAPE '\\'`);
      groupClauses.push(`(${andClauses.join(" AND ")})`);
      params.push(...group.map((t) => `%${t.replace(/([%_\\])/g, "\\$1")}%`));
    }

    const finalClause = groupClauses.join(" OR ");

    const rows = this.db
      .prepare(
        `SELECT sha FROM message WHERE ${finalClause}
          ORDER BY epoch DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<{ sha: string }>;
    return rows.map((r) => r.sha);
  }

  /** Re-home a message after a folder change (archive/move). */
  updateMessageLocation(sha: string, folder: string, newPath: string): boolean {
    const filename = newPath.split("/").pop() ?? "";
    const info = this.stmt.relocate.run(folder, newPath, filename, sha);
    if (!info || Number(info.changes) === 0) return false;
    this.dirty = true;
    return true;
  }

  /** true if the tag was new for this sha. */
  addTag(sha: string, tag: string, ts: string | null = null): boolean {
    const info = this.stmt.addTag.run(sha, tag, ts);
    if (!info || Number(info.changes) === 0) return false;
    this.dirty = true;
    return true;
  }

  /** true if the tag was present and successfully removed. */
  removeTag(sha: string, tag: string): boolean {
    const info = this.stmt.removeTag.run(sha, tag);
    if (!info || Number(info.changes) === 0) return false;
    this.dirty = true;
    return true;
  }

  tagsOf(sha: string): string[] {
    const rows = (this.stmt.tagsOf.all(sha) ?? []) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  graphIsSeen(id: string): boolean {
    return this.stmt.graphSeen.get(id) !== undefined;
  }

  /**
   * Remember a Graph id as handled. `account` is what lets a later removal
   * clear it — ids marked for capped/skipped messages have no message row, so
   * this column is their only attribution.
   */
  graphMarkSeen(id: string, account = ""): void {
    const info = this.stmt.graphMark.run(id, account.trim().toLowerCase());
    if (info && Number(info.changes) > 0) this.dirty = true;
  }

  getState(key: string): string | null {
    const row = this.stmt.getState.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    if (this.getState(key) === value) return;
    this.stmt.setState.run(key, value);
    this.dirty = true;
  }

  /**
   * Forget every message the store holds for an account — rows, their FTS
   * entries, and their tags. Returns how many message rows went.
   *
   * `mail index` and `mail search` read the STORE, not the maildir, so
   * deleting an account's files without this leaves rows pointing at .eml
   * paths that no longer exist and a removed mailbox keeps showing up in
   * "recent mail".
   */
  deleteAccountMessages(account: string): number {
    const rows = this.db
      .prepare("SELECT id, sha, provider_msg_id FROM message WHERE account=?")
      .all(account) as {
      id: number;
      sha: string;
      provider_msg_id: string | null;
    }[];
    const delTag = this.db.prepare("DELETE FROM tag WHERE sha=?");
    // graph_seen gates whether a Graph message is stored AT ALL, so an id left
    // behind makes a re-added mailbox sync as empty. Two passes, because each
    // catches what the other cannot:
    //   - by provider id: reaches rows whose account is '' (imported from a
    //     legacy index.json, which carried no account)
    //   - by account: reaches ids with NO message row at all — the ones marked
    //     for messages skipped by the MAX_PER_FOLDER cap
    const delSeenById = this.db.prepare("DELETE FROM graph_seen WHERE id=?");
    for (const row of rows) {
      this.fts?.del.run(row.id); // FTS is keyed by message.id, not sha
      delTag.run(row.sha);
      if (row.provider_msg_id) delSeenById.run(row.provider_msg_id);
    }
    if (rows.length > 0) {
      this.db.prepare("DELETE FROM message WHERE account=?").run(account);
    }
    // runs even with zero message rows, for the capped-id case above
    this.db
      .prepare("DELETE FROM graph_seen WHERE account=?")
      .run(account.trim().toLowerCase());
    this.dirty = true;
    return rows.length;
  }

  /**
   * Drop an account's resumable sync progress, its cached provider lookups
   * (folder maps, uid watermarks) and its account row. Kept separate from
   * deleteAccountMessages because "remove the account but keep the local
   * mail" must still leave the mail readable — only the sync bookkeeping is
   * dead either way, and stale watermarks would make a later re-add resume
   * from a position that no longer means anything.
   */
  forgetAccountSyncState(account: string): void {
    this.db.prepare("DELETE FROM sync_state WHERE account=?").run(account);
    // kv keys are "<provider>:<address>:<what>" (see gmail.ts / msgraph.ts).
    // Matched by exact segment rather than LIKE so an address containing an
    // underscore cannot wildcard into another account's keys.
    const keys = this.db.prepare("SELECT key FROM kv_state").all() as {
      key: string;
    }[];
    const delKey = this.db.prepare("DELETE FROM kv_state WHERE key=?");
    for (const { key } of keys) {
      const parts = key.split(":");
      if (parts.length >= 3 && parts[1] === account) delKey.run(key);
    }
    this.db.prepare("DELETE FROM account WHERE address=?").run(account);
    this.dirty = true;
  }
}

function toMessageRow(r: Record<string, unknown>): MessageRow {
  const row: MessageRow = {
    sha: String(r.sha),
    account: String(r.account),
    folder: String(r.folder),
    filename: String(r.filename),
    path: String(r.path),
    date: String(r.date_text),
    epoch: Number(r.epoch),
    from: String(r.from_text),
    to: String(r.to_text),
    subject: String(r.subject),
    body: typeof r.body_text === "string" ? r.body_text : "",
  };
  if (typeof r.labels_json === "string") {
    try {
      const labels: unknown = JSON.parse(r.labels_json);
      if (Array.isArray(labels)) row.labels = labels.map(String);
    } catch {
      /* labels stay absent on a malformed blob */
    }
  }
  if (r.provider_msg_id != null) row.gmailId = String(r.provider_msg_id);
  if (r.rfc_message_id != null) row.rfcMessageId = String(r.rfc_message_id);
  if (Number(r.meta_only)) row.metaOnly = true;
  return row;
}

/**
 * Folder segment of a room-relative message path, or "" when it is not a
 * maildir message path. Layout is accounts/<address>/mail/<Folder>/<sub>/<file>.
 */
export function folderOfRoomPath(roomPath: string): string {
  const parts = String(roomPath).split(/[/\\]/);
  return parts.length >= 5 && parts[0] === "accounts" && parts[2] === "mail"
    ? String(parts[3])
    : "";
}
