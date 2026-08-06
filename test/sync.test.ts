/**
 * `mail sync [--wait-for <id>] [--timeout N]`: the room writes
 * .sync-request.jsonl; the broker consumes it inside the cycle, forces a
 * provider sync even in a (normally local-only) push cycle, optionally
 * re-syncs until the awaited id is indexed, and reports SYNCED /
 * SYNC TIMEOUT through send_results.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { Broker, type BrokerOptions } from "../src/broker.js";
import { tmpHome } from "./helpers.js";

const SYNC_FILE = ".sync-request.jsonl";

function makeSyncBroker(
  opts: { onGmailSync?: (broker: Broker, call: number) => void } = {},
) {
  const holder: { broker?: Broker } = {};
  let calls = 0;
  const options: BrokerOptions = {
    mode: "boundary",
    gmailSync: async () => {
      calls += 1;
      opts.onGmailSync?.(holder.broker!, calls);
    },
    graphSync: async () => {},
    detectProvider: async () => null,
    syncWaitPollMs: 1,
    hostSettingsProbe: () => ({
      file: null,
      changedSinceSpawn: false,
      staleClientId: false,
      notices: [],
    }),
  };
  const broker = new Broker(tmpHome(), options);
  holder.broker = broker;
  fs.writeFileSync(
    broker.layout.configPath,
    JSON.stringify({
      dry_run: true,
      pull_interval_seconds: 0,
      accounts: [{ provider: "gmail", address: "a@gmail.com" }],
    }),
  );
  broker.loginManager.ensureFlow = async () => "http://localhost:9/fake";
  broker.gmailSetup.ensureFlow = async () => "http://localhost:9/fake";
  return { broker, syncCalls: () => calls };
}

function queueSyncRequest(broker: Broker, request: object): void {
  fs.appendFileSync(
    path.join(broker.layout.room, SYNC_FILE),
    JSON.stringify(request) + "\n",
  );
}

/** A metadata-only row standing in for a provider-synced message. */
function indexRow(
  broker: Broker,
  opts: { sha?: string; rfcMessageId?: string },
): void {
  broker.index.insertMessage({
    sha: opts.sha ?? "gm:w1",
    account: "a@gmail.com",
    folder: "INBOX",
    filename: "",
    path: "",
    date: "",
    epoch: 1,
    from: "peer@example.com",
    to: "a@gmail.com",
    subject: "expected reply",
    body: "",
    gmailId: "w1",
    rfcMessageId: opts.rfcMessageId,
    metaOnly: true,
  });
}

describe("mail sync requests", () => {
  it("forces a provider sync in a push cycle and reports SYNCED", async () => {
    const { broker, syncCalls } = makeSyncBroker();
    await broker.runCycle({ syncNetwork: false });
    expect(syncCalls()).toBe(0); // a local cycle alone never syncs
    queueSyncRequest(broker, { ts: "2026-08-07T10:00:00Z" });

    const lines = await broker.pushReport();
    expect(syncCalls()).toBe(1);
    expect(lines.join("\n")).toContain("SYNCED: mailboxes were refreshed");
    expect(broker.ledger.readAll().map((r) => r.op)).toContain("sync_executed");
    broker.close();
  });

  it("re-syncs until the awaited Message-ID is indexed (brackets optional)", async () => {
    const { broker, syncCalls } = makeSyncBroker({
      onGmailSync: (b, call) => {
        if (call >= 2) indexRow(b, { rfcMessageId: "<w-1@example.com>" });
      },
    });
    queueSyncRequest(broker, { wait_for: "w-1@example.com", timeout: 10 });

    const lines = await broker.pushReport();
    expect(syncCalls()).toBe(2); // the forced sync, then one wait re-sync
    expect(lines.join("\n")).toContain("SYNCED: w-1@example.com is indexed");
    const done = broker.ledger
      .readAll()
      .filter((r) => r.op === "sync_wait_done");
    expect(done).toHaveLength(1);
    broker.close();
  });

  it("resolves a 12-hex wait target against content shas", async () => {
    const { broker, syncCalls } = makeSyncBroker();
    indexRow(broker, { sha: "abc123abc123" });
    queueSyncRequest(broker, { wait_for: "abc123abc123", timeout: 10 });

    const lines = await broker.pushReport();
    expect(syncCalls()).toBe(1); // found right after the forced sync
    expect(lines.join("\n")).toContain("SYNCED: abc123abc123 is indexed");
    broker.close();
  });

  it("reports SYNC TIMEOUT with the never-resend instruction", async () => {
    const { broker } = makeSyncBroker();
    queueSyncRequest(broker, { wait_for: "<never@example.com>", timeout: 0 });

    const lines = await broker.pushReport();
    const flat = lines.join("\n");
    expect(flat).toContain("SYNC TIMEOUT: <never@example.com>");
    expect(flat).toContain("NEVER resend");
    const timedOut = broker.ledger
      .readAll()
      .filter((r) => r.op === "sync_wait_timeout");
    expect(timedOut).toHaveLength(1);
    broker.close();
  });

  it("caps the requested timeout at SYNC_WAIT_MAX_S", async () => {
    const { broker } = makeSyncBroker();
    indexRow(broker, { rfcMessageId: "<w-2@example.com>" });
    queueSyncRequest(broker, { wait_for: "<w-2@example.com>", timeout: 9999 });

    await broker.pushReport();
    const done = broker.ledger
      .readAll()
      .filter((r) => r.op === "sync_wait_done");
    expect(done).toHaveLength(1);
    expect((done[0]?.details as { timeout_s?: number }).timeout_s).toBe(45);
    broker.close();
  });
});
