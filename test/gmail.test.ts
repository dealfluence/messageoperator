import { describe, expect, it } from "vitest";

import {
  ConnectionCache,
  fetchBodies,
  sync,
  type GmailClientLike,
} from "../src/gmail.js";
import {
  makeConfig,
  makeIndex,
  makeLayout,
  makeLedger,
  sampleEml,
} from "./helpers.js";

const ACCT = { provider: "gmail" as const, address: "a@gmail.com" };

interface FakeFolder {
  uidValidity: number;
  messages: Map<number, Buffer>; // uid -> raw
}

class FakeImap implements GmailClientLike {
  calls: string[] = [];
  folders: Record<string, FakeFolder>;
  dead = false;

  async messageMove(): Promise<unknown> {
    this.calls.push("messageMove");
    return undefined;
  }
  async messageCopy(): Promise<unknown> {
    this.calls.push("messageCopy");
    return undefined;
  }
  async append(): Promise<{ uid?: number } | false> {
    this.calls.push("append");
    return { uid: 1 };
  }

  constructor(folders: Record<string, FakeFolder>) {
    this.folders = folders;
  }

  private folder(name: string): FakeFolder {
    const f = this.folders[name];
    if (!f) throw new Error(`no such folder ${name}`);
    return f;
  }

  async noop(): Promise<void> {
    this.calls.push("noop");
    if (this.dead) throw new Error("connection lost");
  }

  async status(
    mailbox: string,
    _q: { uidNext: boolean; uidValidity: boolean },
  ) {
    this.calls.push(`status:${mailbox}`);
    const f = this.folder(mailbox);
    const maxUid = Math.max(0, ...f.messages.keys());
    return { uidNext: maxUid + 1, uidValidity: f.uidValidity };
  }

  async mailboxOpen(mailbox: string, opts: { readOnly: boolean }) {
    this.calls.push(`open:${mailbox}:${opts.readOnly ? "ro" : "rw"}`);
    return { uidValidity: this.folder(mailbox).uidValidity };
  }

  async search(query: any, _opts: { uid: boolean }) {
    this.calls.push(`search:${JSON.stringify(query)}`);
    const opened = this.calls.filter((c) => c.startsWith("open:")).at(-1)!;
    const f = this.folder(opened.split(":")[1]!);
    const uids = [...f.messages.keys()];
    if (query.uid) {
      const start = Number(String(query.uid).split(":")[0]);
      return uids.filter((u) => u >= start);
    }
    return uids;
  }

  async *fetch(
    range: number[] | string,
    _q: { source: boolean },
    _o: { uid: boolean },
  ) {
    this.calls.push(`fetch:${Array.isArray(range) ? range.join(",") : range}`);
    const opened = this.calls.filter((c) => c.startsWith("open:")).at(-1)!;
    const f = this.folder(opened.split(":")[1]!);
    const uids = Array.isArray(range) ? range : [...f.messages.keys()];
    for (const uid of uids) {
      const source = f.messages.get(uid);
      if (source) yield { uid, source };
    }
  }

  async list() {
    this.calls.push("list");
    return [
      { path: "INBOX" },
      { path: "[Gmail]/Lähetetyt", specialUse: "\\Sent" },
    ];
  }

  async logout(): Promise<void> {
    this.calls.push("logout");
  }

  close(): void {
    this.calls.push("close");
  }
}

function fixtures() {
  const layout = makeLayout();
  const index = makeIndex(layout);
  const ledger = makeLedger(layout);
  const cfg = makeConfig({ accounts: [ACCT] });
  const client = new FakeImap({
    INBOX: {
      uidValidity: 7,
      messages: new Map([
        [1, sampleEml({ subject: "first", messageId: "<1@g>" })],
        [2, sampleEml({ subject: "second", messageId: "<2@g>" })],
      ]),
    },
    "[Gmail]/Lähetetyt": { uidValidity: 9, messages: new Map() },
  });
  const opts = {
    clientFactory: async () => client,
    getPassword: () => "abcdabcdabcdabcd",
  };
  return { layout, index, ledger, cfg, client, opts };
}

describe("gmail sync", () => {
  it("discovers the localized Sent folder via SPECIAL-USE and caches it", async () => {
    const { layout, index, ledger, cfg, client, opts } = fixtures();
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(index.getState("gmail:a@gmail.com:sent_folder")).toBe(
      "[Gmail]/Lähetetyt",
    );
    expect(client.calls.filter((c) => c === "list")).toHaveLength(1);

    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(client.calls.filter((c) => c === "list")).toHaveLength(1); // cached
  });

  it("stores the initial window and records the UID high-water mark", async () => {
    const { layout, index, ledger, cfg, opts } = fixtures();
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(
      index
        .allMessages()
        .map((m) => m.subject)
        .sort(),
    ).toEqual(["first", "second"]);
    expect(index.getState("gmail:a@gmail.com:INBOX")).toBe("7:2");
  });

  it("short-circuits a no-change cycle with a STATUS probe", async () => {
    const { layout, index, ledger, cfg, client, opts } = fixtures();
    await sync(layout, index, ledger, cfg, new Set(), opts);
    const opens = client.calls.filter((c) => c.startsWith("open:INBOX")).length;

    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(client.calls.filter((c) => c.startsWith("open:INBOX")).length).toBe(
      opens,
    );
    expect(
      client.calls.filter((c) => c.startsWith("status:INBOX")).length,
    ).toBeGreaterThan(0);
  });

  it("fetches only new UIDs on later cycles", async () => {
    const { layout, index, ledger, cfg, client, opts } = fixtures();
    await sync(layout, index, ledger, cfg, new Set(), opts);
    client.folders.INBOX!.messages.set(
      3,
      sampleEml({ subject: "third", messageId: "<3@g>" }),
    );

    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(
      index
        .allMessages()
        .map((m) => m.subject)
        .sort(),
    ).toEqual(["first", "second", "third"]);
    expect(index.getState("gmail:a@gmail.com:INBOX")).toBe("7:3");
    const fetches = client.calls.filter((c) => c.startsWith("fetch:"));
    expect(fetches.at(-1)).toBe("fetch:3");
  });

  it("resets the high-water mark when UIDVALIDITY changes", async () => {
    const { layout, index, ledger, cfg, client, opts } = fixtures();
    await sync(layout, index, ledger, cfg, new Set(), opts);
    client.folders.INBOX!.uidValidity = 8; // mailbox rebuilt

    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(index.getState("gmail:a@gmail.com:INBOX")).toBe("8:2");
    // messages are re-listed but sha dedup keeps the room duplicate-free
    expect(index.allMessages()).toHaveLength(2);
  });

  it("skips the account when no app password is available", async () => {
    const { layout, index, ledger, cfg, client } = fixtures();
    await sync(layout, index, ledger, cfg, new Set(), {
      clientFactory: async () => client,
      getPassword: () => null,
    });
    expect(client.calls).toEqual([]);
    expect(index.allMessages()).toEqual([]);
  });

  it("reconnects transparently when the cached connection died", async () => {
    const { layout, index, ledger, cfg, client, opts } = fixtures();
    const cache = new ConnectionCache();
    await sync(layout, index, ledger, cfg, new Set(), {
      ...opts,
      connCache: cache,
    });
    client.dead = true; // NOOP will fail; factory hands back the same fake (revived)
    client.folders.INBOX!.messages.set(
      3,
      sampleEml({ subject: "third", messageId: "<3@g>" }),
    );
    const factory = async () => {
      client.dead = false;
      return client;
    };
    await sync(layout, index, ledger, cfg, new Set(), {
      ...opts,
      clientFactory: factory,
      connCache: cache,
    });
    expect(index.allMessages()).toHaveLength(3);
  });
});

describe("connection error handling", () => {
  it("an 'error' event on an idle cached connection does not throw", async () => {
    const { EventEmitter } = await import("node:events");
    const { attachConnectionErrorLogger } = await import("../src/gmail.js");
    const conn = new EventEmitter();
    attachConnectionErrorLogger(conn, "a@gmail.com");
    // without a listener this emit would throw ERR_UNHANDLED_ERROR and, in
    // the real server, kill the whole process minutes after the last call
    expect(() =>
      conn.emit("error", new Error("Connection closed by server")),
    ).not.toThrow();
  });
});

describe("on-demand body fetch (gmail)", () => {
  class FakeAllMailFetch implements GmailClientLike {
    searches: object[] = [];
    constructor(
      public byEmailId: Record<string, { uid: number; raw: Buffer }>,
    ) {}
    async noop() {}
    async logout() {}
    close() {}
    async messageMove() {
      return undefined;
    }
    async messageCopy() {
      return undefined;
    }
    async append() {
      return { uid: 1 };
    }
    async list() {
      return [{ path: "[Gmail]/All Mail", specialUse: "\\All" }];
    }
    async status() {
      return { uidNext: 1, uidValidity: 1 };
    }
    async mailboxOpen() {
      return { uidValidity: 1, exists: 0, uidNext: 1 };
    }
    async search(query: { emailId?: string; uid?: string }) {
      this.searches.push(query);
      if (query.emailId) {
        const hit = this.byEmailId[query.emailId];
        return hit ? [hit.uid] : [];
      }
      return [];
    }
    async *fetch(range: number[] | string, _q: { source?: boolean }) {
      const want = new Set(Array.isArray(range) ? range : []);
      for (const { uid, raw } of Object.values(this.byEmailId)) {
        if (want.has(uid)) yield { uid, source: raw };
      }
    }
  }

  it("fetches bodies by X-GM-MSGID from All Mail", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    const raw = sampleEml({ subject: "old", body: "found me" });
    const client = new FakeAllMailFetch({ g1: { uid: 7, raw } });
    const got = await fetchBodies(
      layout,
      index,
      cfg,
      ACCT,
      [
        { sha: "gm:g1", providerMsgId: "g1" },
        { sha: "gm:gone", providerMsgId: "gone" },
      ],
      {
        clientFactory: async () => client,
        getPassword: () => "abcdabcdabcdabcd",
      },
    );
    expect(got.get("gm:g1")).toEqual(raw);
    expect(got.has("gm:gone")).toBe(false);
    index.close();
  });

  it("fetches legacy uid:<n> provider ids by uid range", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    const raw = sampleEml({ subject: "legacy" });
    const client = new FakeAllMailFetch({ ignored: { uid: 9, raw } });
    const got = await fetchBodies(
      layout,
      index,
      cfg,
      ACCT,
      [{ sha: "gm:uid:9", providerMsgId: "uid:9" }],
      {
        clientFactory: async () => client,
        getPassword: () => "abcdabcdabcdabcd",
      },
    );
    expect(got.get("gm:uid:9")).toEqual(raw);
    index.close();
  });
});
