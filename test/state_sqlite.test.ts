import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { Index, type MessageRow } from "../src/state.js";
import { makeIndex, makeLayout } from "./helpers.js";

function row(partial: Partial<MessageRow> & { sha: string }): MessageRow {
  return {
    account: "a@x.com",
    folder: "INBOX",
    filename: `1.${partial.sha}.eml`,
    path: `accounts/a@x.com/mail/INBOX/cur/1.${partial.sha}.eml`,
    date: "Mon, 06 Jul 2026 10:00:00 +0000",
    epoch: 1,
    from: "Alice <alice@example.com>",
    to: "bob@example.com",
    subject: "s",
    body: "b",
    ...partial,
  };
}

describe("Index (SQLite state)", () => {
  it("persists messages across close and reopen", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    index.insertMessage(row({ sha: "abc", subject: "hello", epoch: 42 }));
    index.close();

    const reloaded = makeIndex(layout);
    try {
      expect(reloaded.hasSha("abc")).toBe(true);
      const all = reloaded.allMessages();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        sha: "abc",
        subject: "hello",
        epoch: 42,
        body: "b",
      });
    } finally {
      reloaded.close();
    }
  });

  it("round-trips optional fields: labels, gmailId, metaOnly", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    index.insertMessage(
      row({
        sha: "gm:123",
        path: "",
        filename: "",
        folder: "Archive",
        labels: ["IMPORTANT", "work"],
        gmailId: "123",
        metaOnly: true,
      }),
    );
    index.insertMessage(row({ sha: "plain" }));
    index.close();

    const reloaded = makeIndex(layout);
    try {
      const meta = reloaded.allMessages().find((m) => m.sha === "gm:123");
      expect(meta).toBeDefined();
      expect(meta?.labels).toEqual(["IMPORTANT", "work"]);
      expect(meta?.gmailId).toBe("123");
      expect(meta?.metaOnly).toBe(true);
      const plain = reloaded.allMessages().find((m) => m.sha === "plain");
      expect(plain?.labels).toBeUndefined();
      expect(plain?.gmailId).toBeUndefined();
      expect(plain?.metaOnly).toBeUndefined();
    } finally {
      reloaded.close();
    }
  });

  it("ignores duplicate sha inserts", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    try {
      index.insertMessage(row({ sha: "abc", subject: "first" }));
      index.insertMessage(row({ sha: "abc", subject: "second" }));
      const all = index.allMessages();
      expect(all).toHaveLength(1);
      expect(all[0]?.subject).toBe("first");
    } finally {
      index.close();
    }
  });

  it("re-homes a message with updateMessageLocation", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    try {
      index.insertMessage(row({ sha: "abc" }));
      const moved = index.updateMessageLocation(
        "abc",
        "Archive",
        "accounts/a@x.com/mail/Archive/cur/1.abc.eml",
      );
      expect(moved).toBe(true);
      const m = index.allMessages()[0];
      expect(m?.folder).toBe("Archive");
      expect(m?.path).toBe("accounts/a@x.com/mail/Archive/cur/1.abc.eml");
      expect(m?.filename).toBe("1.abc.eml");
      expect(index.updateMessageLocation("nope", "Archive", "x")).toBe(false);
    } finally {
      index.close();
    }
  });

  it("supports tags on arbitrary shas, deduplicated", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    try {
      // no message row needed: `mail tag` works on any room file
      expect(index.addTag("draftsha", "urgent", "2026-07-06")).toBe(true);
      expect(index.addTag("draftsha", "urgent")).toBe(false);
      expect(index.addTag("draftsha", "later", null)).toBe(true);
      expect(index.tagsOf("draftsha")).toEqual(["later", "urgent"]);
      expect(index.tagsOf("unknown")).toEqual([]);
    } finally {
      index.close();
    }
  });

  it("supports removing tags", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    try {
      index.addTag("draftsha", "urgent", "2026-07-06");
      index.addTag("draftsha", "later", null);
      expect(index.tagsOf("draftsha")).toEqual(["later", "urgent"]);

      expect(index.removeTag("draftsha", "urgent")).toBe(true);
      expect(index.tagsOf("draftsha")).toEqual(["later"]);

      expect(index.removeTag("draftsha", "urgent")).toBe(false);
      expect(index.removeTag("unknown", "later")).toBe(false);
    } finally {
      index.close();
    }
  });

  it("tracks graph ids and sync state", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    index.graphMarkSeen("g-1");
    expect(index.graphIsSeen("g-1")).toBe(true);
    expect(index.graphIsSeen("g-2")).toBe(false);
    index.setState("k", "v");
    index.setState("k", "v2");
    index.close();

    const reloaded = makeIndex(layout);
    try {
      expect(reloaded.graphIsSeen("g-1")).toBe(true);
      expect(reloaded.getState("k")).toBe("v2");
      expect(reloaded.getState("missing")).toBeNull();
    } finally {
      reloaded.close();
    }
  });

  it("imports an existing index.json once, then owns the data", () => {
    const layout = makeLayout();
    const legacy = {
      version: 1,
      messages: {
        old1: row({ sha: "old1", subject: "from json", epoch: 7 }),
        "gm:9": row({
          sha: "gm:9",
          path: "",
          filename: "",
          folder: "Archive",
          labels: ["work"],
          gmailId: "9",
          metaOnly: true,
        }),
      },
      tags: { old1: { urgent: "2026-07-01", vip: null } },
      graphSeen: ["g-7"],
      syncState: { "gmail:a@x.com:INBOX": "5:100" },
    };
    fs.writeFileSync(layout.indexPath, JSON.stringify(legacy));

    const index = makeIndex(layout);
    expect(index.hasSha("old1")).toBe(true);
    expect(index.hasSha("gm:9")).toBe(true);
    expect(index.tagsOf("old1")).toEqual(["urgent", "vip"]);
    expect(index.graphIsSeen("g-7")).toBe(true);
    expect(index.getState("gmail:a@x.com:INBOX")).toBe("5:100");
    const meta = index.allMessages().find((m) => m.sha === "gm:9");
    expect(meta?.metaOnly).toBe(true);
    expect(meta?.labels).toEqual(["work"]);
    index.close();

    // the import must not repeat: wipe the json, reopen, data still there
    fs.writeFileSync(
      layout.indexPath,
      JSON.stringify({ version: 1, messages: {}, tags: {} }),
    );
    const reloaded = makeIndex(layout);
    try {
      expect(reloaded.hasSha("old1")).toBe(true);
    } finally {
      reloaded.close();
    }
  });

  it("starts empty when index.json is corrupt", () => {
    const layout = makeLayout();
    fs.writeFileSync(layout.indexPath, "{nope");
    const index = makeIndex(layout);
    try {
      expect(index.allMessages()).toEqual([]);
    } finally {
      index.close();
    }
  });

  it("full-text search finds messages by body and subject", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    try {
      index.insertMessage(
        row({ sha: "m1", subject: "invoice open", body: "please send money" }),
      );
      index.insertMessage(
        row({
          sha: "m2",
          subject: "invoice done",
          body: "settled, paid in full",
          epoch: 2,
        }),
      );
      expect(index.searchShas("money")).toEqual(["m1"]);
      const both = index.searchShas("invoice");
      expect(both.sort()).toEqual(["m1", "m2"]);
    } finally {
      index.close();
    }
  });

  it("supports boolean OR query logic", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    try {
      index.insertMessage(
        row({ sha: "m1", subject: "apple", body: "irrelevant" }),
      );
      index.insertMessage(row({ sha: "m2", subject: "banana", body: "thor" }));
      index.insertMessage(
        row({ sha: "m3", subject: "cherry", body: "orange" }),
      );

      expect(index.searchShas("apple OR banana").sort()).toEqual(["m1", "m2"]);
      expect(index.searchShas("thor").sort()).toEqual(["m2"]);
      expect(index.searchShas("cherry OR orange").sort()).toEqual(["m3"]);
    } finally {
      index.close();
    }
  });

  it("answers provider-id and rfc-id dedup probes per account", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    try {
      index.insertMessage(
        row({
          sha: "m1",
          gmailId: "g-77",
          rfcMessageId: "<orig-1@example.com>",
        }),
      );
      expect(index.hasProviderMsg("a@x.com", "g-77")).toBe(true);
      expect(index.hasProviderMsg("other@x.com", "g-77")).toBe(false);
      expect(index.hasProviderMsg("a@x.com", "g-88")).toBe(false);
      expect(index.hasRfcMessageId("a@x.com", "<orig-1@example.com>")).toBe(
        true,
      );
      expect(index.hasRfcMessageId("a@x.com", "<other@example.com>")).toBe(
        false,
      );
    } finally {
      index.close();
    }
  });

  it("round-trips rfcMessageId on message rows", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    index.insertMessage(
      row({ sha: "m1", rfcMessageId: "<orig-1@example.com>" }),
    );
    index.close();
    const reloaded = makeIndex(layout);
    try {
      expect(reloaded.allMessages()[0]?.rfcMessageId).toBe(
        "<orig-1@example.com>",
      );
    } finally {
      reloaded.close();
    }
  });

  it("persists structured per-mailbox sync state for the backfill", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    expect(index.getSyncState("a@x.com", "[Gmail]/All Mail")).toBeNull();
    index.putSyncState({
      account: "a@x.com",
      mailbox: "[Gmail]/All Mail",
      uidValidity: 42,
      lastUid: 900,
      lowUid: 400,
      cursor: null,
      status: "in_progress",
      totalExpected: 1000,
    });
    index.close();

    const reloaded = makeIndex(layout);
    try {
      const st = reloaded.getSyncState("a@x.com", "[Gmail]/All Mail");
      expect(st).toMatchObject({
        uidValidity: 42,
        lastUid: 900,
        lowUid: 400,
        status: "in_progress",
        totalExpected: 1000,
      });
      reloaded.putSyncState({
        account: "a@x.com",
        mailbox: "[Gmail]/All Mail",
        uidValidity: 42,
        lastUid: 900,
        lowUid: 0,
        cursor: "next-link",
        status: "caught_up",
        totalExpected: 1000,
      });
      const updated = reloaded.getSyncState("a@x.com", "[Gmail]/All Mail");
      expect(updated?.lowUid).toBe(0);
      expect(updated?.cursor).toBe("next-link");
      expect(updated?.status).toBe("caught_up");
    } finally {
      reloaded.close();
    }
  });

  it("attaches a fetched body, then evicts it back to metadata", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    try {
      index.insertMessage(
        row({
          sha: "gm:g1",
          path: "",
          filename: "",
          folder: "Archive",
          gmailId: "g1",
          metaOnly: true,
          body: "",
        }),
      );
      const ok = index.attachFetchedBody("gm:g1", {
        path: "accounts/a@x.com/mail/.Cache/cur/1.abc.eml",
        filename: "1.abc.eml",
        maildirFile: ".Cache/cur/1.abc.eml",
        bodySize: 1234,
        bodyText: "the long lost body",
        now: 111,
      });
      expect(ok).toBe(true);
      const m = index.getBySha("gm:g1");
      expect(m?.metaOnly).toBeUndefined();
      expect(m?.path).toContain(".Cache/cur/");
      expect(index.searchShas("lost")).toEqual(["gm:g1"]);
      expect(index.inboundCacheBytes()).toBe(1234);
      expect(index.lruVictims().map((v) => v.sha)).toEqual(["gm:g1"]);

      expect(index.evictBody("gm:g1")).toBe(true);
      const evicted = index.getBySha("gm:g1");
      expect(evicted?.metaOnly).toBe(true);
      expect(evicted?.path).toBe("");
      expect(index.searchShas("lost")).toEqual([]);
      expect(index.inboundCacheBytes()).toBe(0);
      expect(index.evictBody("gm:g1")).toBe(false); // already evicted
    } finally {
      index.close();
    }
  });

  it("orders LRU victims by last access; touch and pin change the outcome", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    try {
      for (const [sha, at] of [
        ["gm:a", 100],
        ["gm:b", 200],
      ] as const) {
        index.insertMessage(
          row({
            sha,
            path: "",
            filename: "",
            gmailId: sha.slice(3),
            metaOnly: true,
            body: "",
          }),
        );
        index.attachFetchedBody(sha, {
          path: `accounts/a@x.com/mail/.Cache/cur/${sha}.eml`,
          filename: `${sha}.eml`,
          maildirFile: `.Cache/cur/${sha}.eml`,
          bodySize: 10,
          bodyText: "x",
          now: at,
        });
      }
      expect(index.lruVictims().map((v) => v.sha)).toEqual(["gm:a", "gm:b"]);
      index.touchBody("gm:a", 300);
      expect(index.lruVictims().map((v) => v.sha)).toEqual(["gm:b", "gm:a"]);
      index.pinBody("gm:b");
      expect(index.lruVictims().map((v) => v.sha)).toEqual(["gm:a"]);
      expect(index.inboundCacheBytes()).toBe(10); // pinned bytes excluded
    } finally {
      index.close();
    }
  });

  it("degrades to LIKE search when the runtime has no FTS5", () => {
    const layout = makeLayout();
    process.env.MESSAGEOPERATOR_DISABLE_FTS5 = "1";
    try {
      const index = makeIndex(layout);
      try {
        index.insertMessage(
          row({ sha: "m1", subject: "Invoice open", body: "send money" }),
        );
        index.insertMessage(
          row({ sha: "m2", subject: "other", body: "irrelevant", epoch: 2 }),
        );
        // no FTS table was created, search still answers (substring, AND)
        expect(index.searchShas("invoi")).toEqual(["m1"]);
        expect(index.searchShas("invoice money")).toEqual(["m1"]);
        expect(index.searchShas("send money")).toEqual(["m1"]);
        expect(index.searchShas("nonexistent")).toEqual([]);

        // OR fallback test
        index.insertMessage(
          row({ sha: "l1", subject: "apple", body: "irrelevant" }),
        );
        index.insertMessage(
          row({ sha: "l2", subject: "banana", body: "thor" }),
        );
        expect(index.searchShas("apple OR banana").sort()).toEqual([
          "l1",
          "l2",
        ]);
        expect(index.searchShas("thor").sort()).toEqual(["l2"]);
        // body attach/evict keep working without the index
        index.insertMessage(
          row({
            sha: "gm:x",
            path: "",
            filename: "",
            gmailId: "x",
            metaOnly: true,
            body: "",
          }),
        );
        index.attachFetchedBody("gm:x", {
          path: "accounts/a@x.com/mail/.Cache/cur/1.x.eml",
          filename: "1.x.eml",
          maildirFile: ".Cache/cur/1.x.eml",
          bodySize: 10,
          bodyText: "fetched text here",
        });
        expect(index.searchShas("fetched text")).toEqual(["gm:x"]);
        expect(index.evictBody("gm:x")).toBe(true);
        expect(index.searchShas("fetched text")).toEqual([]);
      } finally {
        index.close();
      }
    } finally {
      delete process.env.MESSAGEOPERATOR_DISABLE_FTS5;
    }
  });

  it("transaction() batches writes atomically and rolls back on error", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    try {
      const inserted = index.transaction(() => {
        index.insertMessage(row({ sha: "t1", subject: "batched one" }));
        index.insertMessage(row({ sha: "t2", subject: "batched two" }));
        return 2;
      });
      expect(inserted).toBe(2);
      expect(index.hasSha("t1")).toBe(true);
      expect(index.hasSha("t2")).toBe(true);
      expect(index.searchShas("batched")).toHaveLength(2);

      // a throwing batch leaves NOTHING behind (message and FTS rows alike)
      expect(() =>
        index.transaction(() => {
          index.insertMessage(row({ sha: "t3", subject: "doomed" }));
          index.putSyncState({
            account: "a@x.com",
            mailbox: "doomed",
            uidValidity: 1,
            lastUid: 1,
            lowUid: 0,
            cursor: null,
            status: "in_progress",
            totalExpected: null,
          });
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(index.hasSha("t3")).toBe(false);
      expect(index.searchShas("doomed")).toEqual([]);
      expect(index.getSyncState("a@x.com", "doomed")).toBeNull();

      // the connection is reusable after a rollback
      index.insertMessage(row({ sha: "t4" }));
      expect(index.hasSha("t4")).toBe(true);
    } finally {
      index.close();
    }
  });

  it("keeps working via the layout.indexPath constructor contract", () => {
    // broker.ts constructs with explicit paths; verify the raw form too
    const layout = makeLayout();
    const index = new Index(layout.dbPath, { legacyJson: layout.indexPath });
    try {
      index.insertMessage(row({ sha: "abc" }));
      expect(index.hasSha("abc")).toBe(true);
    } finally {
      index.close();
    }
  });

  describe("folder drift", () => {
    it("reconcileFolder re-homes a row toward the provider and reports it", () => {
      const index = makeIndex(makeLayout());
      try {
        index.insertMessage(
          row({ sha: "drift1", folder: "INBOX", gmailId: "P-1" }),
        );
        // the user archived it in Gmail's web UI; sync sees INBOX gone
        const moved = index.reconcileFolder("a@x.com", "P-1", "Archive", []);
        expect(moved).toMatchObject({
          sha: "drift1",
          from: "INBOX",
          to: "Archive",
        });
        expect(index.getBySha("drift1")?.folder).toBe("Archive");
        expect(index.getBySha("drift1")?.labels).toEqual([]);
      } finally {
        index.close();
      }
    });

    it("reconcileFolder is a no-op when the folders already agree", () => {
      const index = makeIndex(makeLayout());
      try {
        index.insertMessage(
          row({ sha: "same1", folder: "INBOX", gmailId: "P-2" }),
        );
        expect(index.reconcileFolder("a@x.com", "P-2", "INBOX")).toBeNull();
        expect(index.reconcileFolder("a@x.com", "nope", "Archive")).toBeNull();
      } finally {
        index.close();
      }
    });

    it("flags a file left behind by a reconciled row", () => {
      const index = makeIndex(makeLayout());
      try {
        index.insertMessage(
          row({ sha: "drift2", folder: "INBOX", gmailId: "P-3" }),
        );
        expect(index.rowsWithMisplacedFiles()).toEqual([]);
        index.reconcileFolder("a@x.com", "P-3", "Archive");
        // the row says Archive but its path is still under INBOX
        expect(index.rowsWithMisplacedFiles()).toMatchObject([
          { sha: "drift2", folder: "Archive" },
        ]);
      } finally {
        index.close();
      }
    });

    it("never drags an on-demand cached body out of .Cache", () => {
      // REGRESSION: a cached body legitimately lives in the per-account .Cache
      // maildir while its row keeps the logical folder. Treating that as drift
      // moved every cached body out and defeated the LRU cache.
      const index = makeIndex(makeLayout());
      try {
        index.insertMessage(
          row({
            sha: "cached1",
            folder: "Archive",
            path: "accounts/a@x.com/mail/.Cache/cur/1.cached1.eml",
          }),
        );
        expect(index.rowsWithMisplacedFiles()).toEqual([]);
      } finally {
        index.close();
      }
    });

    it("leaves room-owned folders like Drafts alone", () => {
      const index = makeIndex(makeLayout());
      try {
        index.insertMessage(
          row({
            sha: "draft1",
            folder: "Drafts",
            path: "accounts/a@x.com/mail/INBOX/cur/1.draft1.eml",
          }),
        );
        expect(index.rowsWithMisplacedFiles()).toEqual([]);
      } finally {
        index.close();
      }
    });
  });

  describe("removing an account", () => {
    it("deleteAccountMessages drops only that account's rows, tags and FTS", () => {
      const index = makeIndex(makeLayout());
      try {
        index.insertMessage(
          row({ sha: "gone1", account: "old@x.com", subject: "zebrafish" }),
        );
        index.insertMessage(
          row({ sha: "gone2", account: "old@x.com", subject: "zebrafish" }),
        );
        index.insertMessage(
          row({ sha: "stays", account: "new@x.com", subject: "zebrafish" }),
        );
        index.addTag("gone1", "urgent");
        index.addTag("stays", "urgent");
        expect(index.searchShas("zebrafish").sort()).toEqual([
          "gone1",
          "gone2",
          "stays",
        ]);

        expect(index.deleteAccountMessages("old@x.com")).toBe(2);

        expect(index.getBySha("gone1")).toBeNull();
        expect(index.getBySha("gone2")).toBeNull();
        expect(index.getBySha("stays")).not.toBeNull();
        expect(index.tagsOf("gone1")).toEqual([]);
        expect(index.tagsOf("stays")).toEqual(["urgent"]);
        // search must not resurrect them either — it reads the same store
        expect(index.searchShas("zebrafish")).toEqual(["stays"]);

        // idempotent: removing twice is not an error
        expect(index.deleteAccountMessages("old@x.com")).toBe(0);
      } finally {
        index.close();
      }
    });

    it("clears graph_seen ids that have NO message row (capped/skipped)", () => {
      // The gap this closes: Graph ids marked seen for messages skipped by the
      // MAX_PER_FOLDER cap have no message row, so they cannot be found through
      // the account's messages. Left behind, they make a re-added mailbox skip
      // those messages forever. Only the account column can attribute them.
      const index = makeIndex(makeLayout());
      try {
        index.graphMarkSeen("CAPPED-1", "old@x.com");
        index.graphMarkSeen("CAPPED-2", "old@x.com");
        index.graphMarkSeen("OTHER-1", "new@x.com");
        // no insertMessage at all: nothing links these ids to a message

        expect(index.deleteAccountMessages("old@x.com")).toBe(0);

        expect(index.graphIsSeen("CAPPED-1")).toBe(false);
        expect(index.graphIsSeen("CAPPED-2")).toBe(false);
        expect(index.graphIsSeen("OTHER-1")).toBe(true);
      } finally {
        index.close();
      }
    });

    it("matches the account case-insensitively when clearing graph_seen", () => {
      const index = makeIndex(makeLayout());
      try {
        index.graphMarkSeen("MIXED-1", "Old@X.com");
        index.deleteAccountMessages("old@x.com");
        expect(index.graphIsSeen("MIXED-1")).toBe(false);
      } finally {
        index.close();
      }
    });

    it("clears graph_seen for the account so a re-add can sync again", () => {
      // graph_seen decides whether a Graph message is stored at all; a left
      // over id makes the re-added mailbox come back empty
      const index = makeIndex(makeLayout());
      try {
        index.insertMessage(
          row({ sha: "msgone", account: "old@x.com", gmailId: "AAA" }),
        );
        index.insertMessage(
          row({ sha: "msgtwo", account: "new@x.com", gmailId: "BBB" }),
        );
        index.graphMarkSeen("AAA");
        index.graphMarkSeen("BBB");

        index.deleteAccountMessages("old@x.com");

        expect(index.graphIsSeen("AAA")).toBe(false);
        expect(index.graphIsSeen("BBB")).toBe(true); // other account untouched
      } finally {
        index.close();
      }
    });

    it("forgetAccountSyncState clears watermarks per account, not globally", () => {
      const index = makeIndex(makeLayout());
      try {
        index.setState("gmail:old@x.com:all_folder", "[Gmail]/All Mail");
        index.setState("graph:old@x.com:folders", "{}");
        index.setState("gmail:new@x.com:all_folder", "[Gmail]/All Mail");

        index.forgetAccountSyncState("old@x.com");

        expect(index.getState("gmail:old@x.com:all_folder")).toBeNull();
        expect(index.getState("graph:old@x.com:folders")).toBeNull();
        expect(index.getState("gmail:new@x.com:all_folder")).toBe(
          "[Gmail]/All Mail",
        );
      } finally {
        index.close();
      }
    });

    it("an underscore in an address cannot wildcard into another account", () => {
      // guards the exact-segment match: a LIKE '%:a_b@x.com:%' pattern would
      // also delete keys for a1b@x.com, silently resetting a live account
      const index = makeIndex(makeLayout());
      try {
        index.setState("gmail:a_b@x.com:all_folder", "doomed");
        index.setState("gmail:a1b@x.com:all_folder", "innocent");

        index.forgetAccountSyncState("a_b@x.com");

        expect(index.getState("gmail:a_b@x.com:all_folder")).toBeNull();
        expect(index.getState("gmail:a1b@x.com:all_folder")).toBe("innocent");
      } finally {
        index.close();
      }
    });

    it("keeps messages when only the sync state is forgotten", () => {
      // "remove the account but keep the local mail" must stay readable
      const index = makeIndex(makeLayout());
      try {
        index.insertMessage(row({ sha: "keepme", account: "old@x.com" }));
        index.forgetAccountSyncState("old@x.com");
        expect(index.getBySha("keepme")).not.toBeNull();
      } finally {
        index.close();
      }
    });
  });
});
