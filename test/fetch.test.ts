import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { Broker, type BrokerOptions } from "../src/broker.js";
import type { MessageRow } from "../src/state.js";
import { sampleEml, tmpHome } from "./helpers.js";

const FETCH_FILE = ".fetch-request.jsonl";

function metaRow(partial: Partial<MessageRow> & { sha: string }): MessageRow {
  return {
    account: "a@gmail.com",
    folder: "Archive",
    filename: "",
    path: "",
    date: "Mon, 06 Jul 2026 10:00:00 +0000",
    epoch: 100,
    from: "old@x.com",
    to: "me@gmail.com",
    subject: "archived thing",
    body: "",
    labels: [],
    metaOnly: true,
    ...partial,
  };
}

function makeFetchBroker(
  opts: {
    bodies?: Record<string, Buffer>;
    graphBodies?: Record<string, Buffer>;
    cacheMb?: number;
  } = {},
) {
  const home = tmpHome();
  const fetched: string[] = [];
  const broker = new Broker(home, {
    mode: "boundary",
    gmailSync: async () => {},
    graphSync: async () => {},
    detectProvider: async () => null,
    bodyFetchers: {
      gmail: async (_acct, wants) => {
        const out = new Map<string, Buffer>();
        for (const w of wants) {
          fetched.push(w.providerMsgId);
          const raw = opts.bodies?.[w.providerMsgId];
          if (raw) out.set(w.sha, raw);
        }
        return out;
      },
      microsoft: async (_acct, graphId) => {
        fetched.push(graphId);
        const raw = opts.graphBodies?.[graphId];
        if (!raw) throw new Error(`no such graph message ${graphId}`);
        return raw;
      },
    },
  } as BrokerOptions);
  fs.writeFileSync(
    broker.layout.configPath,
    JSON.stringify({
      dry_run: true,
      pull_interval_seconds: 0,
      body_cache_mb: opts.cacheMb ?? 50,
      accounts: [
        { provider: "gmail", address: "a@gmail.com" },
        { provider: "microsoft", address: "m@outlook.com", client_id: "cid" },
      ],
    }),
  );
  broker.loginManager.ensureFlow = async () => "http://localhost:9/fake";
  broker.gmailSetup.ensureFlow = async () => "http://localhost:9/fake";
  return { broker, fetched };
}

function queueFetch(broker: Broker, ...shas: string[]): void {
  fs.appendFileSync(
    path.join(broker.layout.room, FETCH_FILE),
    shas.map((sha) => JSON.stringify({ sha }) + "\n").join(""),
  );
}

describe("on-demand body fetch", () => {
  it("downloads a queued body into .Cache and upgrades the row", async () => {
    const raw = sampleEml({
      subject: "archived thing",
      body: "the long lost body",
      messageId: "<g1@x>",
    });
    const { broker } = makeFetchBroker({ bodies: { g1: raw } });
    try {
      broker.index.insertMessage(metaRow({ sha: "gm:g1", gmailId: "g1" }));
      queueFetch(broker, "gm:g1");
      await broker.runCycle({ syncNetwork: false });

      const row = broker.index.allMessages()[0]!;
      expect(row.metaOnly).toBeUndefined();
      expect(row.path).toContain(".Cache/cur/");
      const full = path.join(broker.layout.room, row.path);
      expect(fs.readFileSync(full)).toEqual(raw);
      expect(fs.existsSync(full + ".meta")).toBe(true);
      // body text became searchable
      expect(broker.index.searchShas("lost body")).toEqual(["gm:g1"]);
      const ops = broker.ledger.readAll().map((r) => r.op);
      expect(ops).toContain("fetch_executed");
      // no audit noise for the new files
      expect(ops).not.toContain("state_diff");
    } finally {
      broker.close();
    }
  });

  it("fetches Microsoft bodies through the graph fetcher", async () => {
    const raw = sampleEml({ subject: "graph mail", body: "graph body" });
    const { broker } = makeFetchBroker({ graphBodies: { "ms-1": raw } });
    try {
      broker.index.insertMessage(
        metaRow({
          sha: "ms:ms-1",
          gmailId: "ms-1",
          account: "m@outlook.com",
        }),
      );
      queueFetch(broker, "ms:ms-1");
      await broker.runCycle({ syncNetwork: false });
      const row = broker.index.allMessages()[0]!;
      expect(row.path).toContain(".Cache/cur/");
    } finally {
      broker.close();
    }
  });

  it("reports the outcome in the push report", async () => {
    const raw = sampleEml({ body: "hello" });
    const { broker } = makeFetchBroker({ bodies: { g1: raw } });
    try {
      broker.index.insertMessage(metaRow({ sha: "gm:g1", gmailId: "g1" }));
      queueFetch(broker, "gm:g1", "gm:missing");
      const lines = await broker.pushReport();
      expect(lines.some((l) => l.startsWith("FETCHED:"))).toBe(true);
      expect(lines.some((l) => l.startsWith("FETCH REJECTED"))).toBe(true);
    } finally {
      broker.close();
    }
  });

  it("rejects unknown ids and rows without a provider id", async () => {
    const { broker } = makeFetchBroker({});
    try {
      broker.index.insertMessage(
        metaRow({ sha: "legacy", gmailId: undefined }),
      );
      queueFetch(broker, "nope", "legacy");
      await broker.runCycle({ syncNetwork: false });
      const rejected = broker.ledger
        .readAll()
        .filter((r) => r.op === "fetch_rejected");
      expect(rejected).toHaveLength(2);
    } finally {
      broker.close();
    }
  });

  it("is a no-op for bodies already on disk", async () => {
    const { broker, fetched } = makeFetchBroker({});
    try {
      broker.index.insertMessage(
        metaRow({
          sha: "onDisk",
          path: "accounts/a@gmail.com/mail/INBOX/cur/1.onDisk.eml",
          filename: "1.onDisk.eml",
          metaOnly: undefined,
          gmailId: "g7",
        }),
      );
      queueFetch(broker, "onDisk");
      await broker.runCycle({ syncNetwork: false });
      expect(fetched).toEqual([]);
      const ops = broker.ledger.readAll().map((r) => r.op);
      expect(ops).toContain("fetch_noop");
      expect(ops).not.toContain("fetch_executed");
    } finally {
      broker.close();
    }
  });
});

describe("LRU body cache", () => {
  it("evicts the least recently used inbound bodies past the quota", async () => {
    const rawA = sampleEml({
      subject: "big A",
      body: "A".repeat(4000),
      messageId: "<a@x>",
    });
    const rawB = sampleEml({
      subject: "big B",
      body: "B".repeat(4000),
      messageId: "<b@x>",
    });
    const { broker } = makeFetchBroker({
      bodies: { ga: rawA, gb: rawB },
      cacheMb: 50,
    });
    try {
      broker.index.insertMessage(
        metaRow({ sha: "gm:ga", gmailId: "ga", subject: "big A", epoch: 1 }),
      );
      broker.index.insertMessage(
        metaRow({ sha: "gm:gb", gmailId: "gb", subject: "big B", epoch: 2 }),
      );
      queueFetch(broker, "gm:ga", "gm:gb");
      await broker.runCycle({ syncNetwork: false });
      expect(
        broker.index.allMessages().every((r) => r.path.includes(".Cache")),
      ).toBe(true);
      // make A the more recently used body
      broker.index.touchBody("gm:ga", Date.now() + 60_000);

      // shrink the quota so only one body fits (each raw is ~4KB)
      const cfg = JSON.parse(
        fs.readFileSync(broker.layout.configPath, "utf-8"),
      );
      cfg.body_cache_mb = 0.005; // ~5KB
      fs.writeFileSync(broker.layout.configPath, JSON.stringify(cfg));
      await broker.runCycle({ syncNetwork: false });

      const rows = broker.index.allMessages();
      const a = rows.find((r) => r.sha === "gm:ga")!;
      const b = rows.find((r) => r.sha === "gm:gb")!;
      expect(a.path).toContain(".Cache"); // recently used: kept
      expect(b.metaOnly).toBe(true); // LRU victim: back to metadata
      expect(b.path).toBe("");
      expect(broker.index.searchShas("BBBB")).toEqual([]);
      const ops = broker.ledger.readAll().map((r) => r.op);
      expect(ops).toContain("body_evicted");
      expect(ops).not.toContain("state_diff");
    } finally {
      broker.close();
    }
  });

  it("never evicts pinned bodies", async () => {
    const raw = sampleEml({ subject: "pinned", body: "keep me" });
    const { broker } = makeFetchBroker({ bodies: { gs: raw }, cacheMb: 0 });
    try {
      broker.index.insertMessage(
        metaRow({ sha: "gm:gs", gmailId: "gs", subject: "pinned" }),
      );
      queueFetch(broker, "gm:gs");
      await broker.runCycle({ syncNetwork: false });
      broker.index.pinBody("gm:gs");
      await broker.runCycle({ syncNetwork: false });
      const row = broker.index.allMessages()[0]!;
      expect(row.path).toContain(".Cache"); // quota 0, still kept
    } finally {
      broker.close();
    }
  });
});
