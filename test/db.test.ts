import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openDb, SCHEMA_VERSION } from "../src/db.js";
import { makeLayout } from "./helpers.js";

describe("openDb", () => {
  it("creates the database file with WAL mode and the schema version", () => {
    const layout = makeLayout();
    const db = openDb(layout.dbPath);
    try {
      expect(fs.existsSync(layout.dbPath)).toBe(true);
      const mode = db.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(mode.journal_mode).toBe("wal");
      const row = db
        .prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get() as { value: string };
      expect(Number(row.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("creates parent directories as needed", () => {
    const layout = makeLayout();
    const nested = path.join(layout.brokerDir, "deep", "store.db");
    const db = openDb(nested);
    db.close();
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("is re-runnable: opening an existing store is a no-op", () => {
    const layout = makeLayout();
    const db1 = openDb(layout.dbPath);
    db1
      .prepare(
        "INSERT INTO message (sha, account, folder) VALUES ('abc', 'a@x.com', 'INBOX')",
      )
      .run();
    db1.close();
    const db2 = openDb(layout.dbPath);
    try {
      const row = db2.prepare("SELECT sha FROM message").get() as {
        sha: string;
      };
      expect(row.sha).toBe("abc");
    } finally {
      db2.close();
    }
  });

  it("supports FTS5 search over subject, addrs, and body", () => {
    const layout = makeLayout();
    const db = openDb(layout.dbPath);
    try {
      db.prepare(
        "INSERT INTO message_fts (rowid, subject, addrs, body) VALUES (1, ?, ?, ?)",
      ).run("quarterly invoice", "alice@example.com", "please pay promptly");
      const hits = db
        .prepare(
          "SELECT rowid FROM message_fts WHERE message_fts MATCH ? ORDER BY rank",
        )
        .all("invoice") as Array<{ rowid: number }>;
      expect(hits.map((h) => h.rowid)).toEqual([1]);
      expect(
        db
          .prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH ?")
          .all("promptly"),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("recreates an unreadable database file instead of failing forever", () => {
    const layout = makeLayout();
    fs.writeFileSync(layout.dbPath, "this is not a sqlite file at all");
    const db = openDb(layout.dbPath);
    try {
      // fresh, usable store
      db.prepare(
        "INSERT INTO message (sha, account, folder) VALUES ('abc', 'a@x.com', 'INBOX')",
      ).run();
      expect(
        (db.prepare("SELECT COUNT(*) c FROM message").get() as { c: number }).c,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("enforces sha uniqueness on message", () => {
    const layout = makeLayout();
    const db = openDb(layout.dbPath);
    try {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO message (sha, account, folder) VALUES ('abc', 'a@x.com', 'INBOX')",
      );
      insert.run();
      const second = insert.run();
      expect(Number(second.changes)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("migrates a v1 graph_seen to per-account, dropping unattributable ids", () => {
    // A pre-v2 id cannot be tied to a mailbox, and that is the defect: it
    // outlives the mailbox's removal and then makes a re-add skip the message
    // forever. Dropping is safe — graph_seen only avoids re-work, and
    // hasSha/hasProviderMsg still prevent duplicate rows.
    const layout = makeLayout();
    fs.mkdirSync(path.dirname(layout.dbPath), { recursive: true });
    const legacy = openDb(layout.dbPath);
    legacy.exec("DROP TABLE IF EXISTS graph_seen");
    legacy.exec("CREATE TABLE graph_seen (id TEXT PRIMARY KEY)"); // v1 shape
    legacy.exec("INSERT INTO graph_seen (id) VALUES ('LEGACY-1')");
    legacy
      .prepare(
        "INSERT INTO meta(key,value) VALUES('schema_version','1') " +
          "ON CONFLICT(key) DO UPDATE SET value='1'",
      )
      .run();
    legacy.close();

    const db = openDb(layout.dbPath);
    try {
      const columns = db.prepare("PRAGMA table_info(graph_seen)").all() as {
        name: string;
      }[];
      expect(columns.map((c) => c.name)).toContain("account");
      const left = db.prepare("SELECT COUNT(*) AS n FROM graph_seen").get() as {
        n: number;
      };
      expect(Number(left.n)).toBe(0);
      const version = db
        .prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get() as { value: string };
      expect(Number(version.value)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("is idempotent: reopening an already-migrated store keeps its ids", () => {
    const layout = makeLayout();
    const first = openDb(layout.dbPath);
    first
      .prepare(
        "INSERT INTO graph_seen (id, account) VALUES ('KEEP-1','a@x.com')",
      )
      .run();
    first.close();

    const again = openDb(layout.dbPath);
    try {
      const row = again
        .prepare("SELECT account FROM graph_seen WHERE id='KEEP-1'")
        .get() as { account: string } | undefined;
      expect(row?.account).toBe("a@x.com");
    } finally {
      again.close();
    }
  });
});
