import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Broker } from "../src/broker.js";
import {
  dryRunSource,
  loadConfig,
  removeAccountFromFile,
  saveSettingsPage,
} from "../src/config.js";
import { SettingsPageFlow, type SettingsState } from "../src/settings_page.js";
import { gmailAppPassword, storeGmailAppPassword } from "../src/creds.js";
import { makeConfig, tmpHome } from "./helpers.js";

function configPath(): string {
  return path.join(tmpHome(), "config.json");
}

describe("settings page precedence (config)", () => {
  it("page-owned values win over the extension pane's env injection", () => {
    const p = configPath();
    fs.writeFileSync(p, JSON.stringify({ dry_run: true }));
    // pane says dry_run on; page turns it off
    saveSettingsPage(p, {
      dry_run: false,
      allowed_recipient_domains: ["Partner.ORG", "@example.com"],
    });
    const cfg = loadConfig(p, { MESSAGEOPERATOR_DRY_RUN: "true" });
    expect(cfg.dry_run).toBe(false); // page wins
    expect(cfg.policy.allowed_recipient_domains).toEqual([
      "partner.org",
      "example.com",
    ]);
    expect(dryRunSource(p, { MESSAGEOPERATOR_DRY_RUN: "true" })).toBe(
      "settings_page",
    );
  });

  it("without page-owned values the pane env still decides (bootstrap preserved)", () => {
    const p = configPath();
    fs.writeFileSync(p, JSON.stringify({ dry_run: true }));
    expect(loadConfig(p, { MESSAGEOPERATOR_DRY_RUN: "false" }).dry_run).toBe(
      false,
    );
    expect(dryRunSource(p, { MESSAGEOPERATOR_DRY_RUN: "false" })).toBe(
      "extension_settings",
    );
    expect(dryRunSource(p, {})).toBe("config_file");
  });

  it("removeAccountFromFile drops the entry and reports absence honestly", () => {
    const p = configPath();
    fs.writeFileSync(
      p,
      JSON.stringify({
        accounts: [{ provider: "gmail", address: "a@gmail.com" }],
      }),
    );
    expect(removeAccountFromFile(p, "A@Gmail.com")).toBe(true);
    expect(loadConfig(p, {}).accounts).toEqual([]);
    expect(removeAccountFromFile(p, "a@gmail.com")).toBe(false);
  });
});

describe("settings page flow", () => {
  const flows: SettingsPageFlow[] = [];
  afterEach(() => {
    for (const flow of flows.splice(0)) flow.closeAll();
  });

  function makeState(): SettingsState {
    return {
      accounts: [
        { address: "a@gmail.com", provider: "gmail", auth: "ok" },
        {
          address: "m@outlook.com",
          provider: "microsoft",
          auth: "needs_login",
        },
      ],
      dry_run: true,
      dry_run_source: "extension_settings",
      allowed_recipient_domains: ["example.com"],
    };
  }

  async function startFlow(
    overrides: {
      onSaveSafety?: (v: {
        dry_run: boolean;
        allowed_recipient_domains: string[];
      }) => void;
      onRemoveAccount?: (address: string, deleteLocal: boolean) => void;
      state?: () => SettingsState;
    } = {},
  ) {
    const flow = new SettingsPageFlow();
    flows.push(flow);
    const url = await flow.ensureFlow({
      getState: overrides.state ?? makeState,
      onSaveSafety: overrides.onSaveSafety ?? (() => {}),
      onRemoveAccount: overrides.onRemoveAccount ?? (() => {}),
    });
    return { flow, url };
  }

  it("serves a nonce-protected page listing accounts, dry run, and allowlist", async () => {
    const { url } = await startFlow();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/settings\/[0-9a-f]{32,}$/);
    const page = await (await fetch(url)).text();
    expect(page).toContain("a@gmail.com");
    expect(page).toContain("m@outlook.com");
    expect(page).toContain("Needs sign-in");
    expect(page).toContain("Dry run");
    expect(page).toContain("example.com");
    expect(page.toLowerCase()).toContain("only you"); // human-only framing
    const bad = await fetch(
      new URL(url).origin + "/settings/" + "0".repeat(32),
    );
    expect(bad.status).toBe(404);
  });

  it("saving safety settings calls the persistence hook with parsed values", async () => {
    const saved: any[] = [];
    const { url } = await startFlow({ onSaveSafety: (v) => saved.push(v) });
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "save_safety",
        allowed_recipient_domains: "example.com, partner.org, ",
      }).toString(), // dry_run checkbox unticked -> off
    });
    expect((await resp.text()).toLowerCase()).toContain("saved");
    expect(saved).toEqual([
      {
        dry_run: false,
        allowed_recipient_domains: ["example.com", "partner.org"],
      },
    ]);
  });

  it("removing an account passes address and delete-local choice through", async () => {
    const removed: Array<[string, boolean]> = [];
    const { url } = await startFlow({
      onRemoveAccount: (address, deleteLocal) =>
        removed.push([address, deleteLocal]),
    });
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "remove_account",
        address: "a@gmail.com",
        delete_local: "on",
      }).toString(),
    });
    expect(removed).toEqual([["a@gmail.com", true]]);
  });

  it("a hook failure surfaces on the page instead of crashing the flow", async () => {
    const { flow, url } = await startFlow({
      onSaveSafety: () => {
        throw new Error("disk full");
      },
    });
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "save_safety",
        dry_run: "on",
      }).toString(),
    });
    expect(await resp.text()).toContain("Something went wrong");
    expect(flow.pendingUrl()).toBe(url); // still alive
  });
});

describe("broker settings integration", () => {
  async function makeBroker(): Promise<Broker> {
    const broker = new Broker(tmpHome(), {
      mode: "boundary",
      gmailSync: async () => {},
      graphSync: async () => {},
      detectProvider: async () => null,
    });
    broker.loginManager.ensureFlow = async () =>
      "http://localhost:9999/ms-fake";
    broker.gmailSetup.ensureFlow = async () =>
      "http://127.0.0.1:9999/setup/fake";
    fs.writeFileSync(
      broker.layout.configPath,
      JSON.stringify({
        dry_run: true,
        pull_interval_seconds: 0,
        accounts: [{ provider: "gmail", address: "a@gmail.com" }],
      }),
    );
    return broker;
  }

  it("a `mail settings` request opens the page and ledgers it", async () => {
    const broker = await makeBroker();
    const opened: string[] = [];
    broker.settingsPage.ensureFlow = async () => {
      const url = "http://127.0.0.1:9999/settings/fake";
      opened.push(url);
      return url;
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".settings-request.json"),
      JSON.stringify({ ts: "now" }),
    );
    await broker.push();
    expect(opened).toHaveLength(1);
    expect(
      broker.ledger.readAll().some((r) => r.op === "settings_opened"),
    ).toBe(true);
    broker.close();
  });

  it("account removal deletes credential + config entry and queued local mail on next cycle", async () => {
    const broker = await makeBroker();
    let hooks: any;
    broker.settingsPage.ensureFlow = async (opts) => {
      hooks = opts;
      return "http://127.0.0.1:9999/settings/fake";
    };
    // connected account with credential and some local mail
    await storeGmailAppPassword(
      broker.layout,
      "a@gmail.com",
      "abcdefghijklmnop",
    );
    await broker.runCycle({ syncNetwork: false }); // creates account dirs + baseline
    const inbox = path.join(
      broker.layout.accounts,
      "a@gmail.com",
      "mail",
      "INBOX",
      "cur",
    );
    fs.writeFileSync(path.join(inbox, "1.aaa.eml"), "x");
    await broker.runCycle({ syncNetwork: false });

    fs.writeFileSync(
      path.join(broker.layout.room, ".settings-request.json"),
      JSON.stringify({ ts: "now" }),
    );
    await broker.push(); // opens page, captures hooks
    await hooks.onRemoveAccount("a@gmail.com", true); // the human clicks Remove

    // asserted through the resolver, not a file path: on macOS/Windows the
    // secret lives in the OS store, so a missing file would prove nothing
    expect(
      await gmailAppPassword(broker.layout, makeConfig(), "a@gmail.com", {}),
    ).toBeNull();
    expect(loadConfig(broker.layout.configPath, {}).accounts).toEqual([]);
    expect(
      broker.ledger.readAll().some((r) => r.op === "account_removed"),
    ).toBe(true);

    const offset = broker.ledger.tailOffset();
    await broker.push(); // pending removal executes this cycle
    expect(
      fs.existsSync(path.join(broker.layout.accounts, "a@gmail.com")),
    ).toBe(false);
    const since = broker.ledger.readSince(offset);
    expect(since.some((r) => r.op === "account_local_mail_deleted")).toBe(true);
    expect(since.some((r) => r.op === "state_diff")).toBe(false); // deletion explained
    broker.close();
  });

  it("deleting local mail also purges the account from the index", async () => {
    // Field report: remove account + delete local mail, then ask for recent
    // mail — and the deleted account's messages are still listed. `mail index`
    // and `mail search` read the store, not the maildir, so deleting the files
    // alone leaves rows pointing at .eml paths that no longer exist.
    const broker = await makeBroker();
    let hooks: any;
    broker.settingsPage.ensureFlow = async (opts) => {
      hooks = opts;
      return "http://127.0.0.1:9999/settings/fake";
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".settings-request.json"),
      JSON.stringify({ ts: "now" }),
    );
    await broker.push();

    // one message per account, so we can prove the purge is scoped
    broker.index.insertMessage({
      sha: "aaaaaaaaaaaa",
      account: "a@gmail.com",
      folder: "INBOX",
      filename: "1.eml",
      path: "accounts/a@gmail.com/mail/INBOX/cur/1.eml",
      date: "Mon, 06 Jul 2026 10:00:00 +0000",
      epoch: 1700000000,
      from: "x@example.com",
      to: "a@gmail.com",
      subject: "doomed account mail",
      body: "doomed account mail",
    });
    broker.index.insertMessage({
      sha: "bbbbbbbbbbbb",
      account: "keep@gmail.com",
      folder: "INBOX",
      filename: "2.eml",
      path: "accounts/keep@gmail.com/mail/INBOX/cur/2.eml",
      date: "Mon, 06 Jul 2026 11:00:00 +0000",
      epoch: 1700000100,
      from: "y@example.com",
      to: "keep@gmail.com",
      subject: "surviving account mail",
      body: "surviving account mail",
    });
    broker.index.setState("gmail:a@gmail.com:all_folder", "[Gmail]/All Mail");
    broker.index.setState(
      "gmail:keep@gmail.com:all_folder",
      "[Gmail]/All Mail",
    );

    await hooks.onRemoveAccount("a@gmail.com", true);
    await broker.push(); // pending removal executes this cycle

    // the removed account leaves nothing behind for `mail index` to list
    expect(broker.index.getBySha("aaaaaaaaaaaa")).toBeNull();
    expect(
      broker.index.allMessages().filter((m) => m.account === "a@gmail.com"),
    ).toEqual([]);
    expect(broker.index.getState("gmail:a@gmail.com:all_folder")).toBeNull();

    // ...and the other account is untouched
    expect(broker.index.getBySha("bbbbbbbbbbbb")).not.toBeNull();
    expect(broker.index.getState("gmail:keep@gmail.com:all_folder")).toBe(
      "[Gmail]/All Mail",
    );
    broker.close();
  });

  it("removing an account but KEEPING local mail leaves the index readable", async () => {
    // The other half of the contract: "keep the local copy" exists so the user
    // can still read that mail offline, so the rows must survive. Only the
    // credential, the config entry, and the sync watermarks go.
    const broker = await makeBroker();
    let hooks: any;
    broker.settingsPage.ensureFlow = async (opts) => {
      hooks = opts;
      return "http://127.0.0.1:9999/settings/fake";
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".settings-request.json"),
      JSON.stringify({ ts: "now" }),
    );
    await broker.push();

    broker.index.insertMessage({
      sha: "cccccccccccc",
      account: "a@gmail.com",
      folder: "INBOX",
      filename: "3.eml",
      path: "accounts/a@gmail.com/mail/INBOX/cur/3.eml",
      date: "Mon, 06 Jul 2026 10:00:00 +0000",
      epoch: 1700000000,
      from: "x@example.com",
      to: "a@gmail.com",
      subject: "kept mail",
      body: "kept mail",
    });

    await hooks.onRemoveAccount("a@gmail.com", false);
    await broker.push();

    expect(broker.index.getBySha("cccccccccccc")).not.toBeNull();
    expect(
      fs.existsSync(path.join(broker.layout.accounts, "a@gmail.com")),
    ).toBe(true);
    broker.close();
  });

  it("republishes status at removal so the next command sees it, throttle or not", async () => {
    // pull() is throttled to one cycle per pull_interval_seconds and returns
    // BEFORE running when not due, and only a cycle writes the status file. So
    // without an immediate republish, "remove the account, then list emails"
    // could read a status file still listing the mailbox as connected — and
    // present a removed mailbox's mail as live.
    const broker = await makeBroker();
    let hooks: any;
    broker.settingsPage.ensureFlow = async (opts) => {
      hooks = opts;
      return "http://127.0.0.1:9999/settings/fake";
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".settings-request.json"),
      JSON.stringify({ ts: "now" }),
    );
    await broker.push();

    const statusPath = path.join(broker.layout.room, ".broker-status.json");
    const before = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    expect(before.connected_accounts).toEqual(["a@gmail.com"]);

    await hooks.onRemoveAccount("a@gmail.com", false); // NO further cycle

    const after = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    expect(after.connected_accounts).toEqual([]);
    broker.close();
  });

  it("republishes status when dry run is changed from the page", async () => {
    // `mail archive` reads dry_run from the status file to tell the user whether
    // the change will be simulated; a stale file announces the opposite of what
    // the broker will actually do
    const broker = await makeBroker();
    let hooks: any;
    broker.settingsPage.ensureFlow = async (opts) => {
      hooks = opts;
      return "http://127.0.0.1:9999/settings/fake";
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".settings-request.json"),
      JSON.stringify({ ts: "now" }),
    );
    await broker.push();

    const statusPath = path.join(broker.layout.room, ".broker-status.json");
    expect(JSON.parse(fs.readFileSync(statusPath, "utf-8")).dry_run).toBe(true);

    await hooks.onSaveSafety({
      dry_run: false,
      allowed_recipient_domains: [],
    });

    expect(JSON.parse(fs.readFileSync(statusPath, "utf-8")).dry_run).toBe(
      false,
    );
    broker.close();
  });

  it("safety saved from the page beats the extension env on the next cycle", async () => {
    const broker = await makeBroker();
    let hooks: any;
    broker.settingsPage.ensureFlow = async (opts) => {
      hooks = opts;
      return "http://127.0.0.1:9999/settings/fake";
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".settings-request.json"),
      JSON.stringify({ ts: "now" }),
    );
    await broker.push();
    await hooks.onSaveSafety({
      dry_run: false,
      allowed_recipient_domains: ["example.com"],
    });

    const cfg = loadConfig(broker.layout.configPath, {
      MESSAGEOPERATOR_DRY_RUN: "true",
    });
    expect(cfg.dry_run).toBe(false);
    expect(cfg.policy.allowed_recipient_domains).toEqual(["example.com"]);
    expect(
      broker.ledger.readAll().some((r) => r.op === "settings_changed"),
    ).toBe(true);
    broker.close();
  });
});
