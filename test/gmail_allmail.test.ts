import { describe, expect, it } from "vitest";

import { sync, type GmailClientLike } from "../src/gmail.js";
import { makeConfig, makeIndex, makeLayout, makeLedger } from "./helpers.js";

const ACCT = { provider: "gmail" as const, address: "a@gmail.com" };
const ALL = "[Gmail]/All Mail";

interface MetaMsg {
  uid: number;
  labels: string[];
  from: string;
  subject: string;
  emailId: string;
  /** raw source, served to the INBOX/Sent folder sync when labeled so */
  source?: Buffer;
}

/**
 * Fake Gmail: INBOX/Sent folder sync + [Gmail]/All Mail metadata scans.
 * Records fetch traffic so tests can assert chunking and no-refetch.
 */
class FakeGmail implements GmailClientLike {
  uidValidity = 42;
  /** every uid ever served by an All-Mail metadata fetch */
  metaFetched: number[] = [];
  /** All-Mail fetch invocations (one per chunk) */
  metaFetchCalls = 0;
  allMailOpens = 0;
  folderSearches: object[] = [];
  /** advances a fake clock on each All-Mail fetch when set */
  onMetaFetch: (() => void) | null = null;

  constructor(public msgs: MetaMsg[]) {}

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
    return [
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "[Gmail]/Sent Mail", specialUse: "\\Sent" },
      { path: ALL, specialUse: "\\All" },
    ];
  }
  private maxUid(): number {
    return Math.max(0, ...this.msgs.map((m) => m.uid));
  }
  async status() {
    return { uidNext: this.maxUid() + 1, uidValidity: this.uidValidity };
  }
  async mailboxOpen(mailbox: string) {
    this.currentMailbox = mailbox;
    if (mailbox === ALL) {
      this.allMailOpens += 1;
      return {
        uidValidity: this.uidValidity,
        exists: this.msgs.length,
        uidNext: this.maxUid() + 1,
      };
    }
    return { uidValidity: 1, exists: 0, uidNext: 1 };
  }
  private inFolder(mailbox: string): MetaMsg[] {
    if (mailbox === ALL) return this.msgs;
    const label = mailbox === "INBOX" ? "\\Inbox" : "\\Sent";
    return this.msgs.filter((m) => m.source && m.labels.includes(label));
  }
  currentMailbox = "INBOX";
  async search(query: {
    all?: boolean;
    uid?: string;
    since?: Date;
  }): Promise<number[]> {
    if (this.currentMailbox !== ALL) this.folderSearches.push(query);
    const pool = this.inFolder(this.currentMailbox);
    if (query.uid) {
      const [lo, hi] = String(query.uid).split(":", 2);
      const min = Number(lo);
      const max = hi === "*" ? Infinity : Number(hi);
      return pool.filter((m) => m.uid >= min && m.uid <= max).map((m) => m.uid);
    }
    return pool.map((m) => m.uid);
  }
  async *fetch(
    range: number[] | string,
    q: { source?: boolean },
    _opts: { uid: boolean },
  ) {
    let want: (uid: number) => boolean;
    if (Array.isArray(range)) {
      const set = new Set(range);
      want = (uid) => set.has(uid);
    } else {
      const [lo, hi] = String(range).split(":", 2);
      const min = Number(lo);
      const max = hi === "*" ? Infinity : Number(hi);
      want = (uid) => uid >= min && uid <= max;
    }
    const pool = this.inFolder(this.currentMailbox);
    const hits = pool.filter((m) => want(m.uid));
    if (!q.source && this.currentMailbox === ALL) {
      this.metaFetchCalls += 1;
      this.metaFetched.push(...hits.map((m) => m.uid));
      this.onMetaFetch?.();
    }
    for (const m of hits) {
      yield {
        uid: m.uid,
        source: q.source ? m.source : undefined,
        labels: new Set(m.labels),
        emailId: m.emailId,
        internalDate: new Date(Date.UTC(2020, 0, Math.min(m.uid, 27) + 1)),
        size: 1000 + m.uid,
        envelope: {
          subject: m.subject,
          messageId: `<${m.emailId}@x>`,
          from: [{ address: m.from }],
          to: [{ address: "me@gmail.com" }],
        },
      };
    }
  }
}

function archived(uid: number, extra: Partial<MetaMsg> = {}): MetaMsg {
  return {
    uid,
    labels: [],
    from: `sender${uid}@x.com`,
    subject: `msg ${uid}`,
    emailId: `g${uid}`,
    ...extra,
  };
}

function run(client: GmailClientLike, deadline = Infinity, now?: () => number) {
  const layout = makeLayout();
  const index = makeIndex(layout);
  const ledger = makeLedger(layout);
  const cfg = makeConfig({ accounts: [ACCT] });
  const opts = {
    clientFactory: async () => client,
    getPassword: async () => "abcdabcdabcdabcd",
    historyDeadline: deadline,
    now,
  };
  return { layout, index, ledger, cfg, opts };
}

describe("gmail All-Mail chunked backfill", () => {
  it("first touch backfills ALL history as metadata rows, labels preserved", async () => {
    const client = new FakeGmail([
      archived(1, { labels: ["\\Important"] }),
      archived(2),
      archived(3, { labels: ["\\Inbox"] }), // old inbox mail: metadata only
      archived(4, { labels: ["\\Sent"] }), // old sent mail: metadata only
    ]);
    const { index, ledger, cfg, opts, layout } = run(client);
    await sync(layout, index, ledger, cfg, new Set(), opts);

    const rows = index.allMessages();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.metaOnly)).toBe(true);
    expect(rows.every((r) => r.path === "")).toBe(true);
    const inboxRow = rows.find((r) => r.gmailId === "g3");
    expect(inboxRow?.labels).toContain("INBOX");
    expect(inboxRow?.folder).toBe("INBOX");
    const sentRow = rows.find((r) => r.gmailId === "g4");
    expect(sentRow?.folder).toBe("Sent");
    const plain = rows.find((r) => r.gmailId === "g2");
    expect(plain?.folder).toBe("Archive");

    const st = index.getSyncState("a@gmail.com", ALL);
    expect(st?.status).toBe("caught_up");
    expect(st?.lowUid).toBe(0);
    expect(st?.lastUid).toBe(4);
  });

  it("uses a 30-day window for the folder fast sync", async () => {
    const client = new FakeGmail([archived(1)]);
    const { index, ledger, cfg, opts, layout } = run(client);
    await sync(layout, index, ledger, cfg, new Set(), opts);
    const since = (
      client.folderSearches.find(
        (q) => (q as { since?: Date }).since instanceof Date,
      ) as { since: Date } | undefined
    )?.since;
    expect(since).toBeDefined();
    const days = (Date.now() - since!.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it("respects the history deadline: expired budget defers the backfill", async () => {
    const client = new FakeGmail([archived(1), archived(2)]);
    const { index, ledger, cfg, opts, layout } = run(client, 0); // already expired
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(index.allMessages()).toHaveLength(0);
    const st = index.getSyncState("a@gmail.com", ALL);
    expect(st?.status).toBe("in_progress");
    expect(st?.lowUid).toBe(2);

    // fresh budget on the next cycle finishes the job
    opts.historyDeadline = Infinity;
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(index.allMessages()).toHaveLength(2);
    expect(index.getSyncState("a@gmail.com", ALL)?.status).toBe("caught_up");
  });

  it("chunks the backfill and resumes across cycles without refetching", async () => {
    const msgs = Array.from({ length: 450 }, (_, i) => archived(i + 1));
    const client = new FakeGmail(msgs);
    let clock = 0;
    client.onMetaFetch = () => {
      clock += 1000;
    };
    const now = () => clock;
    // budget of 1500 fake-ms: chunk 1 at t=0, chunk 2 at t=1000, stop at t=2000
    const { index, ledger, cfg, opts, layout } = run(client, 1500, now);
    await sync(layout, index, ledger, cfg, new Set(), opts);

    expect(client.metaFetchCalls).toBe(2);
    expect(index.allMessages()).toHaveLength(400); // uids 51..450
    let st = index.getSyncState("a@gmail.com", ALL);
    expect(st?.status).toBe("in_progress");
    expect(st?.lowUid).toBe(50);

    // next cycle: fresh budget, finishes the remaining 50
    opts.historyDeadline = clock + 5000;
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(index.allMessages()).toHaveLength(450);
    st = index.getSyncState("a@gmail.com", ALL);
    expect(st?.status).toBe("caught_up");
    // no uid was ever fetched twice
    expect(new Set(client.metaFetched).size).toBe(client.metaFetched.length);
  });

  it("skips the mailbox entirely on quiet cycles after catch-up", async () => {
    const client = new FakeGmail([archived(1)]);
    const { index, ledger, cfg, opts, layout } = run(client);
    await sync(layout, index, ledger, cfg, new Set(), opts);
    const opens = client.allMailOpens;
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(client.allMailOpens).toBe(opens); // STATUS probe only
  });

  it("indexes new arrivals forward after catch-up", async () => {
    const client = new FakeGmail([archived(1)]);
    const { index, ledger, cfg, opts, layout } = run(client);
    await sync(layout, index, ledger, cfg, new Set(), opts);
    client.msgs.push(archived(2, { subject: "fresh" }));
    await sync(layout, index, ledger, cfg, new Set(), opts);
    const rows = index.allMessages();
    expect(rows.map((r) => r.subject).sort()).toEqual(["fresh", "msg 1"]);
    expect(index.getSyncState("a@gmail.com", ALL)?.lastUid).toBe(2);
  });

  it("does not duplicate messages the folder sync stored with a body", async () => {
    const raw = Buffer.from(
      [
        "From: sender9@x.com",
        "To: me@gmail.com",
        "Subject: inbox mail",
        "Date: Mon, 06 Jul 2026 10:00:00 +0000",
        "Message-ID: <g9@x>",
        "",
        "body here",
        "",
      ].join("\r\n"),
    );
    const client = new FakeGmail([
      archived(9, { labels: ["\\Inbox"], source: raw, subject: "inbox mail" }),
    ]);
    const { index, ledger, cfg, opts, layout } = run(client);
    await sync(layout, index, ledger, cfg, new Set(), opts);
    const rows = index.allMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metaOnly).toBeUndefined(); // the full-body row won
    expect(rows[0]?.gmailId).toBe("g9");
    expect(rows[0]?.path).toContain("INBOX/cur/");
  });

  it("resets on uidValidity change without duplicating history", async () => {
    const client = new FakeGmail([archived(1), archived(2)]);
    const { index, ledger, cfg, opts, layout } = run(client);
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(index.allMessages()).toHaveLength(2);

    client.uidValidity = 43; // mailbox rebuilt, uids renumbered
    client.msgs = [
      archived(11, { emailId: "g1" }),
      archived(12, { emailId: "g2" }),
    ];
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(index.allMessages()).toHaveLength(2); // provider-id dedup held
    const st = index.getSyncState("a@gmail.com", ALL);
    expect(st?.uidValidity).toBe(43);
    expect(st?.status).toBe("caught_up");
  });

  it("migrates the POC2 kv watermark and rescans below it once", async () => {
    const client = new FakeGmail([
      archived(1),
      archived(2),
      archived(3, { labels: ["\\Inbox"] }), // the old code skipped this one
    ]);
    const { index, ledger, cfg, opts, layout } = run(client);
    // what the POC2 forward scan would have left behind
    index.setState("gmail:a@gmail.com:allmail", "42:3");
    index.insertMessage({
      sha: "gm:g1",
      account: "a@gmail.com",
      folder: "Archive",
      filename: "",
      path: "",
      date: "",
      epoch: 1,
      from: "sender1@x.com",
      to: "me@gmail.com",
      subject: "msg 1",
      body: "",
      labels: [],
      gmailId: "g1",
      metaOnly: true,
    });

    await sync(layout, index, ledger, cfg, new Set(), opts);
    const rows = index.allMessages();
    expect(rows).toHaveLength(3); // g1 kept, g2 + g3 (inbox) backfilled
    expect(rows.filter((r) => r.gmailId === "g1")).toHaveLength(1);
    expect(rows.find((r) => r.gmailId === "g3")?.labels).toContain("INBOX");
    expect(index.getSyncState("a@gmail.com", ALL)?.status).toBe("caught_up");
  });
});

describe("gmail folder drift (archived outside Message Operator)", () => {
  it("REGRESSION: an archived message must not stay in the room's inbox", async () => {
    // The user archives a message in Gmail's web UI. Archiving drops the INBOX
    // label but keeps the same All-Mail UID, and the All-Mail scan only fetches
    // UIDs ABOVE its watermark, so the message is never looked at again.
    //
    // Microsoft gets this right via the Graph inbox delta reporting @removed.
    // Gmail has no such signal today, which is what this pins.
    const inboxed = archived(1, { labels: ["INBOX"], subject: "will move" });
    const client = new FakeGmail([inboxed]);
    // the re-read is throttled, so drive a clock we can push past the interval
    let clock = 1_000_000;
    const { index, ledger, cfg, opts, layout } = run(
      client,
      Infinity,
      () => clock,
    );

    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(index.allMessages()[0]?.folder).toBe("INBOX");

    // ...archived in Gmail: same UID, INBOX label gone
    inboxed.labels = [];
    clock += 11 * 60 * 1000; // past RELABEL_INTERVAL_MS
    await sync(layout, index, ledger, cfg, new Set(), opts);

    const row = index.allMessages()[0];
    expect(row?.folder).toBe("Archive");
    expect(row?.labels ?? []).not.toContain("INBOX");
  });
});

describe("gmail label re-read throttle", () => {
  it("leaves quiet cycles alone until the interval has passed", async () => {
    // The re-read costs the quiet-cycle optimisation (a caught-up mailbox
    // otherwise settles for one STATUS round trip), so it must not fire on
    // every tool call.
    const client = new FakeGmail([archived(1, { labels: ["INBOX"] })]);
    let clock = 1_000_000;
    const { index, ledger, cfg, opts, layout } = run(
      client,
      Infinity,
      () => clock,
    );
    await sync(layout, index, ledger, cfg, new Set(), opts);
    const opens = client.allMailOpens;

    clock += 60 * 1000; // a minute later: still inside the interval
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(client.allMailOpens).toBe(opens); // STATUS probe only

    clock += 11 * 60 * 1000; // now past it
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(client.allMailOpens).toBe(opens + 1);
  });

  it("also notices a message put BACK into the inbox", async () => {
    const msg = archived(1, { labels: [], subject: "coming back" });
    const client = new FakeGmail([msg]);
    let clock = 1_000_000;
    const { index, ledger, cfg, opts, layout } = run(
      client,
      Infinity,
      () => clock,
    );
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(index.allMessages()[0]?.folder).toBe("Archive");

    msg.labels = ["INBOX"]; // un-archived in Gmail's UI
    clock += 11 * 60 * 1000;
    await sync(layout, index, ledger, cfg, new Set(), opts);
    expect(index.allMessages()[0]?.folder).toBe("INBOX");
  });
});
