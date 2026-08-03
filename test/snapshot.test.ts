import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildManifest,
  countPendingIntents,
  diffAudit,
  loadHashCache,
  loadPrevious,
  save,
  saveHashCache,
  writeStatus,
  STATUS_FILE,
} from "../src/snapshot.js";
import { makeConfig, makeLayout, makeLedger } from "./helpers.js";

function writeAccountFile(
  layout: ReturnType<typeof makeLayout>,
  rel: string,
  text: string,
): string {
  const full = path.join(layout.room, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

describe("manifest + diff audit", () => {
  it("flags unexplained changes and stays quiet about explained ones", () => {
    const layout = makeLayout();
    const ledger = makeLedger(layout);
    layout.ensureAccount("a@x.com");
    writeAccountFile(
      layout,
      "accounts/a@x.com/mail/INBOX/cur/1.aaa.eml",
      "one",
    );

    const first = buildManifest(layout);
    save(layout, first, null);
    diffAudit(layout, ledger, null, first, new Set()); // baseline: no diff op

    writeAccountFile(
      layout,
      "accounts/a@x.com/mail/INBOX/cur/2.bbb.eml",
      "two",
    );
    writeAccountFile(
      layout,
      "accounts/a@x.com/mail/INBOX/cur/3.ccc.eml",
      "three",
    );
    const second = buildManifest(layout);
    const explained = new Set(["accounts/a@x.com/mail/INBOX/cur/2.bbb.eml"]);
    diffAudit(layout, ledger, loadPrevious(layout), second, explained);

    const diffs = ledger.readAll().filter((r) => r.op === "state_diff");
    expect(diffs).toHaveLength(1);
    expect((diffs[0]!.details as any).added).toEqual([
      "accounts/a@x.com/mail/INBOX/cur/3.ccc.eml",
    ]);
  });

  it("detects modifications through the hash cache", () => {
    const layout = makeLayout();
    layout.ensureAccount("a@x.com");
    const file = writeAccountFile(
      layout,
      "accounts/a@x.com/mail/INBOX/cur/1.aaa.eml",
      "one",
    );
    const cache = loadHashCache(layout);
    const first = buildManifest(layout, cache);
    saveHashCache(layout, cache);

    // same mtime+size ⇒ cache hit ⇒ same sha
    const again = buildManifest(layout, cache);
    expect(again).toEqual(first);

    fs.writeFileSync(file, "two"); // same size, new mtime ⇒ re-hash
    const changed = buildManifest(layout, cache);
    const rel = "accounts/a@x.com/mail/INBOX/cur/1.aaa.eml";
    expect(changed[rel]).not.toBe(first[rel]);

    fs.rmSync(file);
    const gone = buildManifest(layout, cache);
    expect(rel in gone).toBe(false);
    expect(rel in cache).toBe(false); // pruned
  });
});

describe("status", () => {
  it("publishes broker state including auth and pending sign-in urls", () => {
    const layout = makeLayout();
    layout.ensureAccount("a@gmail.com");
    const cfg = makeConfig({
      accounts: [
        { provider: "gmail", address: "a@gmail.com" },
        { provider: "microsoft", address: "m@outlook.com", client_id: "cid" },
      ],
    });
    writeStatus(layout, cfg, {
      pendingIntents: 2,
      networkSynced: false,
      lastNetworkSync: "2026-07-06T10:00:00Z",
      mode: "boundary",
      auth: { "a@gmail.com": "ok", "m@outlook.com": "needs_login" },
      authUrls: { "m@outlook.com": "http://localhost:1234/auth" },
    });
    const status = JSON.parse(
      fs.readFileSync(path.join(layout.room, STATUS_FILE), "utf-8"),
    );
    expect(status.mode).toBe("boundary");
    expect(status.dry_run).toBe(true);
    expect(status.own_addresses).toEqual(["a@gmail.com", "m@outlook.com"]);
    expect(status.pending_intents).toBe(2);
    expect(status.last_network_sync).toBe("2026-07-06T10:00:00Z");
    expect(status.auth["m@outlook.com"]).toBe("needs_login");
    expect(status.auth_urls["m@outlook.com"]).toBe(
      "http://localhost:1234/auth",
    );
  });

  it("separates connected mailboxes from ones that merely have a maildir", () => {
    // The room tells live mail from a removed mailbox's local archive using
    // connected_accounts. `accounts` is the maildir list and CANNOT answer it:
    // removing an account keeps its mail, so the directory outlives the config
    // entry. Conflating the two silently disabled the [disconnected] labelling.
    const layout = makeLayout();
    layout.ensureAccount("live@gmail.com");
    layout.ensureAccount("removed@gmail.com"); // mail kept after removal
    const cfg = makeConfig({
      accounts: [{ provider: "gmail", address: "live@gmail.com" }],
    });
    writeStatus(layout, cfg, {
      pendingIntents: 0,
      networkSynced: false,
      lastNetworkSync: "2026-07-06T10:00:00Z",
      mode: "boundary",
      auth: { "live@gmail.com": "ok" },
    });
    const status = JSON.parse(
      fs.readFileSync(path.join(layout.room, STATUS_FILE), "utf-8"),
    );
    expect(status.connected_accounts).toEqual(["live@gmail.com"]);
    expect(status.accounts).toContain("removed@gmail.com");
  });

  it("counts queued and claimed intents", () => {
    const layout = makeLayout();
    layout.ensureAccount("a@gmail.com");
    const outbox = path.join(
      layout.accounts,
      "a@gmail.com",
      "mail",
      "Outbox",
      "new",
    );
    fs.writeFileSync(path.join(outbox, "1.eml"), "x");
    fs.writeFileSync(path.join(outbox, "1.eml.intent.json"), "{}");
    fs.writeFileSync(path.join(outbox, "2.eml.intent.sending"), "{}");
    expect(countPendingIntents(layout)).toBe(2);
  });
});
