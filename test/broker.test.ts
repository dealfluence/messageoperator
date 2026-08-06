import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { Broker, type BrokerOptions, sendOutcomeLines } from "../src/broker.js";
import { storeGmailAppPassword } from "../src/creds.js";
import { asViewFile, extractDocxMarkdown } from "../src/pack.js";
import {
  clearGmailPassword,
  queueDraftUpload,
  queueSend,
  sampleDocx,
  sampleEml,
  seedGmailPassword,
  tmpHome,
} from "./helpers.js";

async function makeBroker(
  opts: {
    dryRun?: boolean;
    detectProvider?: BrokerOptions["detectProvider"];
    draftUploaders?: BrokerOptions["draftUploaders"];
    hostSettingsProbe?: BrokerOptions["hostSettingsProbe"];
  } = {},
): Promise<Broker> {
  const home = tmpHome();
  const broker = new Broker(home, {
    mode: "boundary",
    // network sync stubs: tests never touch IMAP/Graph
    gmailSync: async () => {},
    graphSync: async () => {},
    deliverers: {
      gmail: async () => "<mid-g>",
      microsoft: async () => "<mid-m>",
    },
    ...(opts.draftUploaders ? { draftUploaders: opts.draftUploaders } : {}),
    detectProvider: opts.detectProvider ?? (async () => null),
    // default: a host with no settings store — tests never probe the real
    // Claude Desktop directories of the machine they run on
    hostSettingsProbe:
      opts.hostSettingsProbe ??
      (() => ({
        file: null,
        changedSinceSpawn: false,
        staleClientId: false,
        notices: [],
      })),
  });
  // default stubs: no test ever starts a real loopback listener or browser
  broker.loginManager.ensureFlow = async () => "http://localhost:9999/ms-fake";
  broker.gmailSetup.ensureFlow = async () => "http://127.0.0.1:9999/setup/fake";
  fs.writeFileSync(
    broker.layout.configPath,
    JSON.stringify({
      dry_run: opts.dryRun ?? true,
      pull_interval_seconds: 0,
      accounts: [
        { provider: "gmail", address: "a@gmail.com" },
        { provider: "microsoft", address: "m@outlook.com", client_id: "cid" },
      ],
    }),
  );
  // authenticate the gmail account: only authenticated addresses count as
  // always-allowed recipients (m@outlook.com stays needs_login)
  await seedGmailPassword(broker.layout, "a@gmail.com");
  // never start a REAL loopback flow (or open a browser!) from a test; the
  // tests that assert on flows override this again with a recorder
  broker.loginManager.ensureFlow = async () =>
    "http://localhost:9999/unpatched-fake";
  return broker;
}

function loginRequest(broker: Broker, request: object): void {
  fs.writeFileSync(
    path.join(broker.layout.room, ".login-request.json"),
    JSON.stringify(request),
  );
}

function fileAccounts(
  broker: Broker,
): Array<{ provider: string; address: string }> {
  return (
    JSON.parse(fs.readFileSync(broker.layout.configPath, "utf-8")).accounts ??
    []
  );
}

describe("history backfill budget", () => {
  it("passes one shared deadline (cycle start + ~2.5s) to both provider syncs", async () => {
    const seen: Array<number | undefined> = [];
    const broker = new Broker(tmpHome(), {
      mode: "boundary",
      gmailSync: async (_l, _i, _le, _c, _e, opts) => {
        seen.push(opts?.historyDeadline);
      },
      graphSync: async (_l, _i, _le, _c, _e, opts) => {
        seen.push(opts?.historyDeadline);
      },
      detectProvider: async () => null,
    });
    try {
      const before = Date.now();
      await broker.runCycle();
      const after = Date.now();
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]); // one budget per cycle, not per provider
      expect(seen[0]).toBeGreaterThanOrEqual(before + 2000);
      expect(seen[0]).toBeLessThanOrEqual(after + 3000);
    } finally {
      broker.close();
    }
  });
});

describe("boundary broker", () => {
  const keysToScrub = [
    "MESSAGEOPERATOR_GMAIL_APP_PW",
    "MESSAGEOPERATOR_GMAIL_ADDRESS",
    "MESSAGEOPERATOR_MS_ADDRESS",
    "MESSAGEOPERATOR_MS_CLIENT_ID",
  ];
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keysToScrub) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keysToScrub) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
  });
  it("reports LOGIN STARTED with the sign-in URL on push", async () => {
    const broker = await makeBroker();
    broker.loginManager.ensureFlow = async () =>
      "http://localhost:9999/ms-signin";
    loginRequest(broker, { address: "m@outlook.com" });

    const outcomes = await broker.pushReport();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toContain("LOGIN STARTED");
    expect(outcomes[0]).toContain("m@outlook.com");
    expect(outcomes[0]).toContain("http://localhost:9999/ms-signin");
    broker.close();
  });

  it("reports LOGIN REJECTED when a first microsoft login has no client_id", async () => {
    // no client_id anywhere: config has no ms account, env is scrubbed by
    // beforeEach. The old code silently no-op'd; now the failure surfaces.
    const broker = await makeBroker();
    fs.writeFileSync(
      broker.layout.configPath,
      JSON.stringify({
        dry_run: true,
        pull_interval_seconds: 0,
        accounts: [{ provider: "gmail", address: "a@gmail.com" }],
      }),
    );
    loginRequest(broker, { address: "uzair@adeu.ai", provider: "microsoft" });

    const outcomes = await broker.pushReport();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toContain("LOGIN REJECTED");
    expect(outcomes[0]).toContain("uzair@adeu.ai");
    expect(outcomes[0]).toContain("client_id");
    broker.close();
  });
  it("uses the connector-set MESSAGEOPERATOR_MS_CLIENT_ID for a first microsoft login", async () => {
    // Regression: a fresh install with the client_id only in the extension
    // settings (env), no microsoft account yet configured. The old code read
    // client_id only from the CLI arg or an EXISTING account, so this
    // first-account login registered nothing and opened no browser.
    process.env.MESSAGEOPERATOR_MS_CLIENT_ID = "env-cid";
    const broker = await makeBroker();
    // config with NO microsoft account at all, so the only client_id source
    // is the env var
    fs.writeFileSync(
      broker.layout.configPath,
      JSON.stringify({
        dry_run: true,
        pull_interval_seconds: 0,
        accounts: [{ provider: "gmail", address: "a@gmail.com" }],
      }),
    );
    const started: Array<[string, string | undefined]> = [];
    broker.loginManager.ensureFlow = async (_layout, acct) => {
      started.push([acct.address, acct.client_id]);
      return "http://localhost:9999/fake";
    };
    loginRequest(broker, { address: "uzair@adeu.ai", provider: "microsoft" });

    await broker.push();

    // the account registered, with the env client_id, and its flow started
    expect(started).toEqual([["uzair@adeu.ai", "env-cid"]]);
    expect(fileAccounts(broker)).toContainEqual({
      provider: "microsoft",
      address: "uzair@adeu.ai",
      client_id: "env-cid",
    });
    broker.close();
  });
  it("bootstraps account trees and publishes status on a cycle", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    expect(broker.layout.accountAddresses()).toEqual([
      "a@gmail.com",
      "m@outlook.com",
    ]);
    const status = JSON.parse(
      fs.readFileSync(
        path.join(broker.layout.room, ".broker-status.json"),
        "utf-8",
      ),
    );
    expect(status.mode).toBe("boundary");
    expect(status.auth["a@gmail.com"]).toBe("ok");
    expect(status.auth["m@outlook.com"]).toBe("needs_login");
    // only the authenticated account is an always-allowed recipient
    expect(status.own_addresses).toEqual(["a@gmail.com"]);
    broker.close();
  });

  it("processes a queued send on push and reports the outcome", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false }); // baseline
    queueSend(broker.layout, "a@gmail.com", sampleEml({ to: "a@gmail.com" }));

    const outcomes = await broker.pushReport();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toContain("SIMULATED");
    broker.close();
  });

  it("refuses recipients that are configured but not authenticated", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    // m@outlook.com is in the config, but nobody has signed in to it — an
    // agent-registered address must not become an allowed recipient
    queueSend(broker.layout, "a@gmail.com", sampleEml({ to: "m@outlook.com" }));

    const outcomes = await broker.pushReport();
    expect(outcomes[0]).toContain("REJECTED (recipient_not_allowed)");
    broker.close();
  });

  it("observes agent-created drafts and explains them to the audit", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    const drafts = path.join(
      broker.layout.accounts,
      "a@gmail.com",
      "mail",
      "Drafts",
      "cur",
    );
    fs.writeFileSync(path.join(drafts, "9.abc.eml"), sampleEml());

    await broker.push();
    const records = broker.ledger.readAll();
    expect(records.some((r) => r.op === "draft_created")).toBe(true);
    expect(records.some((r) => r.op === "state_diff")).toBe(false);
    broker.close();
  });

  it("flags out-of-band room mutations as state_diff", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false }); // baseline manifest
    const inbox = path.join(
      broker.layout.accounts,
      "a@gmail.com",
      "mail",
      "INBOX",
      "cur",
    );
    fs.writeFileSync(path.join(inbox, "5.zzz.eml"), "smuggled");

    await broker.push();
    const diff = broker.ledger.readAll().find((r) => r.op === "state_diff");
    expect(diff).toBeDefined();
    expect((diff!.details as any).added).toContain(
      "accounts/a@gmail.com/mail/INBOX/cur/5.zzz.eml",
    );
    broker.close();
  });

  it("folds mail-tag entries into the index exactly once", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    const entry = {
      sha: "abcdef123456",
      tag: "urgent",
      ts: "2026-07-06T10:00:00Z",
      path: "x",
    };
    fs.writeFileSync(broker.layout.tagsFile, JSON.stringify(entry) + "\n");

    await broker.push();
    expect(broker.index.tagsOf("abcdef123456")).toEqual(["urgent"]);
    expect(fs.existsSync(broker.layout.tagsFile)).toBe(false);
    const tagOps = broker.ledger.readAll().filter((r) => r.op === "tag");
    expect(tagOps).toHaveLength(1);
    broker.close();
  });

  it("folds untag request entries into the index exactly once", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    // First, tag it
    broker.index.addTag("abcdef123456", "urgent", "2026-07-06T10:00:00Z");
    expect(broker.index.tagsOf("abcdef123456")).toEqual(["urgent"]);

    const entry = {
      sha: "abcdef123456",
      tag: "urgent",
      ts: "2026-07-06T10:05:00Z",
      path: "x",
    };
    fs.writeFileSync(
      broker.layout.untagRequestFile,
      JSON.stringify(entry) + "\n",
    );

    await broker.push();
    expect(broker.index.tagsOf("abcdef123456")).toEqual([]);
    expect(fs.existsSync(broker.layout.untagRequestFile)).toBe(false);
    const untagOps = broker.ledger.readAll().filter((r) => r.op === "untag");
    expect(untagOps).toHaveLength(1);
    broker.close();
  });

  it("replays tag and untag entries in timestamp order, so re-tagging wins", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    const tag1 = {
      sha: "abcdef123456",
      tag: "urgent",
      ts: "2026-07-06T10:00:00Z",
      path: "x",
    };
    const tag2 = {
      sha: "abcdef123456",
      tag: "urgent",
      ts: "2026-07-06T10:10:00Z",
      path: "x",
    };
    const untag = {
      sha: "abcdef123456",
      tag: "urgent",
      ts: "2026-07-06T10:05:00Z",
      path: "x",
    };

    fs.writeFileSync(
      broker.layout.tagsFile,
      JSON.stringify(tag1) + "\n" + JSON.stringify(tag2) + "\n",
    );
    fs.writeFileSync(
      broker.layout.untagRequestFile,
      JSON.stringify(untag) + "\n",
    );

    await broker.push();
    expect(broker.index.tagsOf("abcdef123456")).toEqual(["urgent"]);
    expect(fs.existsSync(broker.layout.tagsFile)).toBe(false);
    expect(fs.existsSync(broker.layout.untagRequestFile)).toBe(false);
    broker.close();
  });

  it("handles mixed timestamp formats (Z vs +00:00) chronologically", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    const tag1 = {
      sha: "abcdef123456",
      tag: "urgent",
      ts: "2026-07-06T10:00:01.500000+00:00",
      path: "x",
    };
    const untag = {
      sha: "abcdef123456",
      tag: "urgent",
      ts: "2026-07-06T10:00:01Z",
      path: "x",
    };

    fs.writeFileSync(broker.layout.tagsFile, JSON.stringify(tag1) + "\n");
    fs.writeFileSync(
      broker.layout.untagRequestFile,
      JSON.stringify(untag) + "\n",
    );

    await broker.push();
    expect(broker.index.tagsOf("abcdef123456")).toEqual(["urgent"]);
    broker.close();
  });

  it("persists env-declared accounts so they survive a reinstall", async () => {
    // the settings-pane path: the account exists only as env vars, and used
    // to vanish (with its sync) when the extension was reinstalled with
    // empty settings
    process.env.MESSAGEOPERATOR_GMAIL_ADDRESS = "settings-pane@gmail.com";
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    broker.close();
    delete process.env.MESSAGEOPERATOR_GMAIL_ADDRESS; // "reinstall": env gone
    expect(fileAccounts(broker)).toContainEqual({
      provider: "gmail",
      address: "settings-pane@gmail.com",
    });
    const broker2 = new Broker(broker.layout.home, {
      mode: "boundary",
      gmailSync: async () => {},
      graphSync: async () => {},
    });
    broker2.gmailSetup.ensureFlow = async () =>
      "http://127.0.0.1:9999/setup/fake";
    broker2.loginManager.ensureFlow = async () =>
      "http://localhost:9999/ms-fake";
    await broker2.runCycle({ syncNetwork: false });
    const status = JSON.parse(
      fs.readFileSync(
        path.join(broker2.layout.room, ".broker-status.json"),
        "utf-8",
      ),
    );
    expect(Object.keys(status.auth)).toContain("settings-pane@gmail.com");
    broker2.close();
  });

  it("throttles pulls by pull_interval_seconds", async () => {
    const broker = await makeBroker();
    // interval 0 ⇒ every pull runs
    expect(await broker.pull()).toBe(true);
    expect(await broker.pull()).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(broker.layout.configPath, "utf-8"));
    cfg.pull_interval_seconds = 3600;
    fs.writeFileSync(broker.layout.configPath, JSON.stringify(cfg));
    await broker.pull();
    expect(await broker.pull()).toBe(false); // within the window
    expect(await broker.pull({ force: true })).toBe(true);
    broker.close();
  });

  it("honors a `mail login` request by starting a sign-in flow", async () => {
    const broker = await makeBroker();
    const started: string[] = [];
    // patch the flow starter: a real one would build MSAL auth URLs (network)
    broker.loginManager.ensureFlow = async (_layout, acct) => {
      started.push(acct.address);
      return "http://localhost:9999/fake";
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".login-request.json"),
      JSON.stringify({ address: "m@outlook.com" }),
    );

    await broker.push();
    expect(started).toEqual(["m@outlook.com"]);
    expect(
      fs.existsSync(path.join(broker.layout.room, ".login-request.json")),
    ).toBe(false);
    const login = broker.ledger.readAll().find((r) => r.op === "login_started");
    expect((login!.details as any).trigger).toBe("mail login");
    broker.close();
  });

  it("registers an account from a `mail account add` request and persists it", async () => {
    const broker = await makeBroker();
    fs.writeFileSync(
      path.join(broker.layout.room, ".account-request.json"),
      JSON.stringify({ provider: "gmail", address: "Second@Gmail.com" }),
    );

    await broker.push();
    const cfgFile = JSON.parse(
      fs.readFileSync(broker.layout.configPath, "utf-8"),
    );
    expect(cfgFile.accounts).toContainEqual({
      provider: "gmail",
      address: "second@gmail.com",
    });
    expect(broker.layout.accountAddresses()).toContain("second@gmail.com");
    expect(
      fs.existsSync(path.join(broker.layout.room, ".account-request.json")),
    ).toBe(false);
    const added = broker.ledger.readAll().find((r) => r.op === "account_added");
    expect(added?.actor).toBe("agent");
    // the same cycle's status already reflects the new account
    const status = JSON.parse(
      fs.readFileSync(
        path.join(broker.layout.room, ".broker-status.json"),
        "utf-8",
      ),
    );
    expect(status.auth["second@gmail.com"]).toBe("no_app_password");
    broker.close();
  });

  it("gives an agent-added microsoft account the shared client_id and starts its flow", async () => {
    const broker = await makeBroker();
    const started: Array<{ address: string; client_id?: string }> = [];
    broker.loginManager.ensureFlow = async (_layout, acct) => {
      started.push({ address: acct.address, client_id: acct.client_id });
      return "http://localhost:9999/fake";
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".account-request.json"),
      JSON.stringify({ provider: "microsoft", address: "janne@adeu.ai" }),
    );

    await broker.push();
    // client_id inherited from the existing microsoft account ("cid")
    expect(started).toEqual([{ address: "janne@adeu.ai", client_id: "cid" }]);
    const cfgFile = JSON.parse(
      fs.readFileSync(broker.layout.configPath, "utf-8"),
    );
    expect(cfgFile.accounts).toContainEqual({
      provider: "microsoft",
      address: "janne@adeu.ai",
      client_id: "cid",
    });
    broker.close();
  });

  it("rejects traversal-shaped addresses in account requests", async () => {
    const broker = await makeBroker();
    for (const address of [
      "../../evil@x.com",
      "a/b@x.com",
      "..@x.com",
      "a@x.com/..",
    ]) {
      fs.writeFileSync(
        path.join(broker.layout.room, ".account-request.json"),
        JSON.stringify({ provider: "gmail", address }),
      );
      await broker.push();
    }
    const rejections = broker.ledger
      .readAll()
      .filter((r) => r.op === "account_add_rejected");
    expect(rejections).toHaveLength(4);
    const cfgFile = JSON.parse(
      fs.readFileSync(broker.layout.configPath, "utf-8"),
    );
    expect(cfgFile.accounts).toHaveLength(2); // unchanged
    // nothing escaped accounts/: only the two configured dirs exist
    expect(broker.layout.accountAddresses()).toEqual([
      "a@gmail.com",
      "m@outlook.com",
    ]);
    broker.close();
  });

  it("registers a client_id-less microsoft account as unconfigured, no popup", async () => {
    const broker = await makeBroker();
    // config with no microsoft accounts at all
    fs.writeFileSync(
      broker.layout.configPath,
      JSON.stringify({
        dry_run: true,
        accounts: [{ provider: "gmail", address: "a@gmail.com" }],
      }),
    );
    const started: string[] = [];
    broker.loginManager.ensureFlow = async (_layout, acct) => {
      started.push(acct.address);
      return "http://localhost:9999/fake";
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".account-request.json"),
      JSON.stringify({ provider: "microsoft", address: "janne@adeu.ai" }),
    );

    await broker.push();
    expect(started).toEqual([]); // no client_id -> no sign-in flow yet
    const cfgFile = JSON.parse(
      fs.readFileSync(broker.layout.configPath, "utf-8"),
    );
    expect(cfgFile.accounts).toContainEqual({
      provider: "microsoft",
      address: "janne@adeu.ai",
    });
    // the same cycle's status shows the account so the agent can relay the next step
    const status = JSON.parse(
      fs.readFileSync(
        path.join(broker.layout.room, ".broker-status.json"),
        "utf-8",
      ),
    );
    expect(status.auth["janne@adeu.ai"]).toBe("unconfigured");
    broker.close();
  });

  it("processes several account requests from one tool call (JSONL)", async () => {
    const broker = await makeBroker();
    const started: string[] = [];
    broker.loginManager.ensureFlow = async (_layout, acct) => {
      started.push(acct.address);
      return "http://localhost:9999/fake";
    };
    fs.appendFileSync(
      path.join(broker.layout.room, ".account-request.json"),
      JSON.stringify({ provider: "gmail", address: "extra@gmail.com" }) +
        "\n" +
        JSON.stringify({ provider: "microsoft", address: "janne@adeu.ai" }) +
        "\n",
    );

    await broker.push();
    const cfgFile = JSON.parse(
      fs.readFileSync(broker.layout.configPath, "utf-8"),
    );
    const addresses = cfgFile.accounts.map((a: any) => a.address);
    expect(addresses).toContain("extra@gmail.com");
    expect(addresses).toContain("janne@adeu.ai");
    expect(started).toEqual(["janne@adeu.ai"]); // ms flow started, gmail not
    broker.close();
  });

  it("refuses a microsoft login for an address registered as gmail", async () => {
    const broker = await makeBroker();
    const started: string[] = [];
    broker.loginManager.ensureFlow = async (_layout, acct) => {
      started.push(acct.address);
      return "http://localhost:9999/fake";
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".login-request.json"),
      JSON.stringify({ address: "a@gmail.com", provider: "microsoft" }),
    );

    await broker.push();
    expect(started).toEqual([]);
    const rejected = broker.ledger
      .readAll()
      .find((r) => r.op === "login_rejected");
    expect((rejected!.details as any).reason).toContain("gmail");
    broker.close();
  });

  it("auto-registers an unknown address on `mail login` when a client_id is known", async () => {
    const broker = await makeBroker();
    const started: string[] = [];
    broker.loginManager.ensureFlow = async (_layout, acct) => {
      started.push(acct.address);
      return "http://localhost:9999/fake";
    };
    fs.writeFileSync(
      path.join(broker.layout.room, ".login-request.json"),
      JSON.stringify({ address: "janne@adeu.ai", provider: "microsoft" }),
    );

    await broker.push();
    expect(started).toEqual(["janne@adeu.ai"]);
    const cfgFile = JSON.parse(
      fs.readFileSync(broker.layout.configPath, "utf-8"),
    );
    expect(cfgFile.accounts).toContainEqual({
      provider: "microsoft",
      address: "janne@adeu.ai",
      client_id: "cid",
    });
    // the SAME cycle's status already carries the account's auth state, so
    // the next `mail status` (throttled pull) still shows the sign-in state
    const status = JSON.parse(
      fs.readFileSync(
        path.join(broker.layout.room, ".broker-status.json"),
        "utf-8",
      ),
    );
    expect(status.auth["janne@adeu.ai"]).toBe("needs_login");
    broker.close();
  });

  it("starts a lazy login at pull time, once per process", async () => {
    const broker = await makeBroker();
    const started: string[] = [];
    broker.loginManager.ensureFlow = async (_layout, acct) => {
      started.push(acct.address);
      return "http://localhost:9999/fake";
    };
    await broker.pull({ force: true });
    await broker.pull({ force: true });
    expect(started).toEqual(["m@outlook.com"]); // auto only once
    broker.close();
  });

  it("routes a gmail login request to the app-password wizard", async () => {
    const broker = await makeBroker();
    const started: string[] = [];
    broker.gmailSetup.ensureFlow = async (address) => {
      started.push(address);
      return "http://127.0.0.1:9999/setup/abc";
    };
    loginRequest(broker, { address: "a@gmail.com" });

    await broker.push();
    expect(started).toEqual(["a@gmail.com"]);
    const login = broker.ledger
      .readAll()
      .find(
        (r) =>
          r.op === "login_started" &&
          (r.details as any).account === "a@gmail.com",
      );
    expect((login!.details as any).provider).toBe("gmail");
    expect((login!.details as any).trigger).toBe("mail login");
    broker.close();
  });

  it("registers a brand-new gmail address from an explicit provider", async () => {
    const broker = await makeBroker();
    const started: string[] = [];
    broker.gmailSetup.ensureFlow = async (address) => {
      started.push(address);
      return "http://127.0.0.1:9999/setup/abc";
    };
    loginRequest(broker, { address: "Second@Gmail.com", provider: "gmail" });

    await broker.push();
    expect(started).toEqual(["second@gmail.com"]);
    expect(fileAccounts(broker)).toContainEqual({
      provider: "gmail",
      address: "second@gmail.com",
    });
    // account tree exists so the first sync after setup has a home
    expect(broker.layout.accountAddresses()).toContain("second@gmail.com");
    broker.close();
  });

  it("detects the provider of a new custom-domain address via MX", async () => {
    const broker = await makeBroker({ detectProvider: async () => "gmail" });
    const started: string[] = [];
    broker.gmailSetup.ensureFlow = async (address) => {
      started.push(address);
      return "http://127.0.0.1:9999/setup/abc";
    };
    loginRequest(broker, { address: "jane@mybusiness.fi" });

    await broker.push();
    expect(started).toEqual(["jane@mybusiness.fi"]);
    expect(fileAccounts(broker)).toContainEqual({
      provider: "gmail",
      address: "jane@mybusiness.fi",
    });
    broker.close();
  });

  it("registers nothing when the provider cannot be determined", async () => {
    const broker = await makeBroker(); // detectProvider stub returns null
    const started: string[] = [];
    broker.gmailSetup.ensureFlow = async (address) => {
      started.push(address);
      return "http://127.0.0.1:9999/setup/abc";
    };
    loginRequest(broker, { address: "jane@unknowable.example" });

    await broker.push();
    expect(started).toEqual([]);
    expect(fileAccounts(broker).map((a) => a.address)).not.toContain(
      "jane@unknowable.example",
    );
    broker.close();
  });

  it("reuses an existing microsoft client_id for a new microsoft address", async () => {
    const broker = await makeBroker({
      detectProvider: async () => "microsoft",
    });
    const started: Array<[string, string | undefined]> = [];
    broker.loginManager.ensureFlow = async (_layout, acct) => {
      started.push([acct.address, acct.client_id]);
      return "http://localhost:9999/fake";
    };
    loginRequest(broker, { address: "second@company.com" });

    await broker.push();
    expect(started).toEqual([["second@company.com", "cid"]]); // inherited from m@outlook.com
    expect(fileAccounts(broker)).toContainEqual({
      provider: "microsoft",
      address: "second@company.com",
      client_id: "cid",
    });
    broker.close();
  });

  it("lazily opens the gmail wizard once per process when no password is stored", async () => {
    const broker = await makeBroker();
    // await makeBroker() seeds an app password for a@gmail.com; this test is about
    // the no-password path, so remove it before pulling
    await clearGmailPassword(broker.layout, "a@gmail.com");
    const started: string[] = [];
    broker.gmailSetup.ensureFlow = async (address) => {
      started.push(address);
      return "http://127.0.0.1:9999/setup/abc";
    };
    await broker.pull({ force: true });
    await broker.pull({ force: true });
    expect(started).toEqual(["a@gmail.com"]); // auto only once
    broker.close();
  });

  it("does not open the gmail wizard when a password is already stored", async () => {
    const broker = await makeBroker();
    await storeGmailAppPassword(
      broker.layout,
      "a@gmail.com",
      "abcdefghijklmnop",
    );
    const started: string[] = [];
    broker.gmailSetup.ensureFlow = async (address) => {
      started.push(address);
      return "http://127.0.0.1:9999/setup/abc";
    };
    await broker.pull({ force: true });
    expect(started).toEqual([]);
    broker.close();
  });

  it("publishes gmail wizard URLs in status auth_urls", async () => {
    const broker = await makeBroker();
    broker.gmailSetup.pendingUrls = () => ({
      "a@gmail.com": "http://127.0.0.1:9999/setup/abc",
    });
    await broker.runCycle({ syncNetwork: false });
    const status = JSON.parse(
      fs.readFileSync(
        path.join(broker.layout.room, ".broker-status.json"),
        "utf-8",
      ),
    );
    expect(status.auth_urls["a@gmail.com"]).toBe(
      "http://127.0.0.1:9999/setup/abc",
    );
    broker.close();
  });

  it("delivers for real when dry_run is off", async () => {
    const broker = await makeBroker({ dryRun: false });
    await broker.runCycle({ syncNetwork: false });
    queueSend(
      broker.layout,
      "m@outlook.com",
      sampleEml({ from: "m@outlook.com", to: "a@gmail.com" }),
    );

    const outcomes = await broker.pushReport();
    expect(outcomes[0]).toContain("SENT");
    expect(outcomes[0]).toContain("microsoft");
    broker.close();
  });
});

describe("pack requests", () => {
  /** Seed a .docx + its extracted .md view under attachments/, as sync would. */
  async function seedDocxView(
    broker: Broker,
    paragraphs: string[],
    name = "contract.docx",
  ): Promise<{ mdRel: string; docxPath: string; mdPath: string }> {
    const docx = sampleDocx(paragraphs);
    const dir = path.join(broker.layout.attachments, "abcdef123456");
    fs.mkdirSync(dir, { recursive: true });
    const docxPath = path.join(dir, name);
    const mdPath = docxPath + ".md";
    fs.writeFileSync(docxPath, docx);
    fs.writeFileSync(mdPath, asViewFile(await extractDocxMarkdown(docx)));
    return { mdRel: `attachments/abcdef123456/${name}.md`, docxPath, mdPath };
  }

  function requestPack(broker: Broker, mdRel: string): void {
    fs.appendFileSync(
      path.join(broker.layout.room, ".pack-request.jsonl"),
      JSON.stringify({ path: mdRel, ts: "2026-07-08T10:00:00Z" }) + "\n",
    );
  }

  it("rebases md edits into the docx as tracked changes and refreshes the view", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    const { mdRel, docxPath, mdPath } = await seedDocxView(broker, [
      "The fee is 100 euros.",
    ]);
    fs.writeFileSync(
      mdPath,
      fs.readFileSync(mdPath, "utf-8").replace("100 euros", "250 euros"),
    );
    requestPack(broker, mdRel);

    const outcomes = await broker.pushReport();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toContain("PACKED");
    expect(outcomes[0]).toContain(mdRel);

    // the binary now carries the edit as a pending tracked change
    const packed = await extractDocxMarkdown(fs.readFileSync(docxPath));
    expect(packed).toContain("{--100--}");
    expect(packed).toContain("{++250++}");
    expect(packed).toContain("AI Agent");
    // the view was refreshed to match the packed binary
    expect(fs.readFileSync(mdPath, "utf-8")).toBe(asViewFile(packed));

    const executed = broker.ledger
      .readAll()
      .find((r) => r.op === "pack_executed");
    expect(executed).toBeDefined();
    expect((executed!.details as any).path).toBe(mdRel);
    expect((executed!.details as any).edits_applied).toBe(1);
    // request file consumed
    expect(
      fs.existsSync(path.join(broker.layout.room, ".pack-request.jsonl")),
    ).toBe(false);
    broker.close();
  });

  it("rejects an unchanged view as no_changes and leaves the docx alone", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    const { mdRel, docxPath } = await seedDocxView(broker, ["Original."]);
    const before = fs.readFileSync(docxPath);
    requestPack(broker, mdRel);

    const outcomes = await broker.pushReport();
    expect(outcomes[0]).toContain("PACK REJECTED (no_changes)");
    expect(fs.readFileSync(docxPath).equals(before)).toBe(true);
    broker.close();
  });

  it("rejects a view that is not this document; nothing is saved", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    // @adeu/core 1.30.0 resolves repeated and even identical targets by the
    // position the differ recorded, so the ambiguity rejection this used to
    // exercise no longer happens. The remaining rejection that must leave the
    // binary untouched is a view with nothing in common with the document —
    // an agent that pasted the wrong one (see MIN_DOCUMENT_SIMILARITY).
    const { mdRel, docxPath, mdPath } = await seedDocxView(broker, [
      "Agreement between Alpha Corp and Beta Ltd.",
      "The fee is 100 euros, payable within 30 days.",
    ]);
    const before = fs.readFileSync(docxPath);
    const mdBefore = fs.readFileSync(mdPath, "utf-8");
    fs.writeFileSync(mdPath, "Shopping list.\n\nMilk, bread, coffee.\n");
    requestPack(broker, mdRel);

    const outcomes = await broker.pushReport();
    expect(outcomes[0]).toContain("PACK REJECTED (too_divergent)");
    expect(fs.readFileSync(docxPath).equals(before)).toBe(true);
    // the agent's edited view is NOT clobbered on rejection
    expect(fs.readFileSync(mdPath, "utf-8")).not.toBe(mdBefore);
    broker.close();
  });

  it("refuses pdf views and paths outside attachments/", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    requestPack(broker, "attachments/abcdef123456/report.pdf.md");
    requestPack(broker, "accounts/a@gmail.com/mail/INBOX/cur/x.docx.md");
    requestPack(broker, "attachments/../../broker/evil.docx.md");

    const outcomes = await broker.pushReport();
    expect(outcomes).toHaveLength(3);
    for (const line of outcomes) {
      expect(line).toContain("PACK REJECTED (invalid_path)");
    }
    broker.close();
  });

  it("rejects a view whose files are missing", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    // md exists but the sibling docx does not
    const dir = path.join(broker.layout.attachments, "abcdef123456");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "orphan.docx.md"), "text\n");
    requestPack(broker, "attachments/abcdef123456/orphan.docx.md");
    requestPack(broker, "attachments/abcdef123456/absent.docx.md");

    const outcomes = await broker.pushReport();
    expect(outcomes).toHaveLength(2);
    for (const line of outcomes) {
      expect(line).toContain("PACK REJECTED (not_found)");
    }
    broker.close();
  });

  it("rejects a corrupt docx without killing the cycle", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    const dir = path.join(broker.layout.attachments, "abcdef123456");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.docx"), "not a zip");
    fs.writeFileSync(path.join(dir, "broken.docx.md"), "edited text\n");
    requestPack(broker, "attachments/abcdef123456/broken.docx.md");

    const outcomes = await broker.pushReport();
    expect(outcomes[0]).toContain("PACK REJECTED (error)");
    broker.close();
  });
});

describe("sendOutcomeLines", () => {
  it("renders executed, simulated, and rejected records", () => {
    const lines = sendOutcomeLines([
      {
        ts: "",
        actor: "broker",
        op: "send_executed",
        sha: "abc",
        details: { recipients: ["x@y.com"], channel: "gmail" },
      },
      {
        ts: "",
        actor: "broker",
        op: "send_simulated",
        sha: "def",
        details: { recipients: ["x@y.com"] },
      },
      {
        ts: "",
        actor: "broker",
        op: "send_rejected",
        sha: "ghi",
        details: { reason: "rate_limited", detail: "too many" },
      },
      { ts: "", actor: "broker", op: "sync_message", sha: "jkl", details: {} },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("SENT: abc");
    expect(lines[1]).toContain("SIMULATED: def");
    expect(lines[2]).toContain("REJECTED (rate_limited)");
  });
  it("renders folder change outcomes with empty path using sha fallback", () => {
    const lines = sendOutcomeLines([
      {
        ts: "",
        actor: "broker",
        op: "folder_change_executed",
        sha: "sha123",
        details: { op: "archive", path: "", result: "applied" },
      },
      {
        ts: "",
        actor: "broker",
        op: "folder_change_simulated",
        sha: "sha456",
        details: { op: "unarchive", path: "" },
      },
      {
        ts: "",
        actor: "broker",
        op: "folder_change_rejected",
        sha: "sha787",
        details: {
          op: "archive",
          path: "",
          reason: "failed",
          detail: "error details",
        },
      },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("ARCHIVED: sha123");
    expect(lines[1]).toContain("SIMULATED UNARCHIVE: sha456");
    expect(lines[2]).toContain("ARCHIVE REJECTED (failed)");
    expect(lines[2]).toContain("sha787");
  });
  it("renders login outcomes", () => {
    const lines = sendOutcomeLines([
      {
        ts: "",
        actor: "agent",
        op: "login_started",
        sha: null,
        details: {
          account: "m@outlook.com",
          provider: "microsoft",
          url: "http://localhost:9999/x",
        },
      },
      {
        ts: "",
        actor: "agent",
        op: "login_rejected",
        sha: null,
        details: { address: "u@adeu.ai", reason: "no client_id" },
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("LOGIN STARTED: m@outlook.com");
    expect(lines[0]).toContain("http://localhost:9999/x");
    expect(lines[1]).toContain("LOGIN REJECTED: u@adeu.ai");
    expect(lines[1]).toContain("no client_id");
  });
  it("renders pack outcomes", () => {
    const lines = sendOutcomeLines([
      {
        ts: "",
        actor: "broker",
        op: "pack_executed",
        sha: "abc",
        details: {
          path: "attachments/x/f.docx.md",
          docx: "attachments/x/f.docx",
          edits_applied: 2,
        },
      },
      {
        ts: "",
        actor: "broker",
        op: "pack_rejected",
        sha: null,
        details: {
          path: "attachments/x/f.docx.md",
          reason: "no_changes",
          detail: "nothing to pack",
        },
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("PACKED: attachments/x/f.docx.md");
    expect(lines[0]).toContain("2 edit(s)");
    expect(lines[0]).toContain("attachments/x/f.docx");
    expect(lines[1]).toContain("PACK REJECTED (no_changes)");
    expect(lines[1]).toContain("nothing to pack");
  });

  /**
   * QA 2026-07-24, BUG-2 (medium): a `mail draft` upload queued alongside two
   * sends produced send_results with only the two send rejections in it. The
   * upload had in fact succeeded (confirmed provider-side), but the DraftBox
   * ledger ops have no branch here, so the one field SKILL.md tells agents to
   * trust over the printed NOTE stayed silent about them.
   *
   * pushReportDetailed() slices the whole cycle (ledger.readSince(offset)), so
   * the records DO reach this function — the blind spot is the rendering. Every
   * op processDraftIntent() can append needs a line: draft_uploaded,
   * draft_upload_simulated, draft_rejected, draft_deleted,
   * draft_delete_simulated.
   */
  it("renders provider-draft outcomes (QA 2026-07-24 BUG-2)", () => {
    const lines = sendOutcomeLines([
      {
        ts: "",
        actor: "broker",
        op: "draft_uploaded",
        sha: "23d97b172d87",
        details: {
          account: "a@gmail.com",
          channel: "gmail",
          message_id: "<178491651338.53560.805@gmail.com>",
        },
      },
      {
        ts: "",
        actor: "broker",
        op: "draft_upload_simulated",
        sha: "def456",
        details: { account: "a@gmail.com", channel: "gmail" },
      },
      {
        ts: "",
        actor: "broker",
        op: "draft_rejected",
        sha: null,
        details: {
          account: "a@gmail.com",
          reason: "sha_mismatch",
          detail: "draft content changed after it was queued",
          draft: "1784916512.b472446d6d83.eml",
        },
      },
      {
        ts: "",
        actor: "broker",
        op: "draft_deleted",
        sha: null,
        details: {
          account: "a@gmail.com",
          channel: "gmail",
          message_id: "<old-draft@gmail.com>",
          result: "applied",
        },
      },
      {
        ts: "",
        actor: "broker",
        op: "draft_delete_simulated",
        sha: null,
        details: {
          account: "a@gmail.com",
          channel: "gmail",
          message_id: "<old-draft@gmail.com>",
        },
      },
    ]);

    // every DraftBox outcome must be visible; wording is the fixer's choice,
    // but the state (uploaded / simulated / rejected / deleted) must be stated
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/DRAFT UPLOADED/i);
    expect(lines[0]).toContain("<178491651338.53560.805@gmail.com>");
    expect(lines[1]).toMatch(/SIMULATED/i);
    expect(lines[2]).toMatch(/REJECTED/i);
    expect(lines[2]).toContain("sha_mismatch");
    expect(lines[3]).toMatch(/DRAFT DELETED/i);
    expect(lines[4]).toMatch(/SIMULATED/i);
  });

  /**
   * The same blind spot, one cycle out: a draft upload that really happened
   * must not leave a boundary push with an empty report. Two sends were
   * rejected in the QA cycle, which masked it; with the upload alone the report
   * is completely silent.
   */
  it("reports a draft upload in the boundary push (QA 2026-07-24 BUG-2)", async () => {
    const broker = await makeBroker({
      dryRun: false,
      draftUploaders: {
        gmail: async () => "<uploaded@gmail.com>",
        microsoft: async () => "<uploaded@outlook.com>",
      },
    });
    queueDraftUpload(
      broker.layout,
      "a@gmail.com",
      sampleEml({ from: "a@gmail.com", to: "a@gmail.com" }),
    );

    const lines = await broker.pushReport();

    expect(
      broker.ledger.readAll().map((r) => r.op),
      "precondition: the upload actually ran",
    ).toContain("draft_uploaded");
    expect(lines.join("\n")).toMatch(/DRAFT UPLOADED/i);
    broker.close();
  });
});

describe("host settings staleness", () => {
  // env is injected at spawn: a settings-pane edit only reaches the server
  // after a host restart. These pin the fail-fast surfaces for that gap.
  const key = "MESSAGEOPERATOR_MS_CLIENT_ID";
  let backup: string | undefined;
  beforeEach(() => {
    backup = process.env[key];
    delete process.env[key];
  });
  afterEach(() => {
    if (backup === undefined) delete process.env[key];
    else process.env[key] = backup;
  });

  const staleProbe = () => ({
    file: "claude-extensions-settings.json",
    changedSinceSpawn: true,
    paneClientId: "cid-new",
    staleClientId: true,
    notices: [
      "The extension settings now set Microsoft app (client) ID …id-new, " +
        "but this server is still running with …id-old. Restart the MCP server.",
    ],
  });

  it("publishes restart notices and the effective client ids in status", async () => {
    const broker = await makeBroker({ hostSettingsProbe: staleProbe });
    await broker.runCycle({ syncNetwork: false });
    const status = JSON.parse(
      fs.readFileSync(
        path.join(broker.layout.room, ".broker-status.json"),
        "utf-8",
      ),
    );
    expect(status.notices).toHaveLength(1);
    expect(status.notices[0]).toContain("Restart the MCP server");
    // the id actually in use is visible (masked) so a user who just changed
    // the pane can verify whether their edit landed
    expect(status.ms_client_ids["m@outlook.com"]).toEqual({
      suffix: "…cid",
      source: "config_file",
    });
    broker.close();
  });

  it("publishes no notices when the host leaves no settings store", async () => {
    const broker = await makeBroker();
    await broker.runCycle({ syncNetwork: false });
    const status = JSON.parse(
      fs.readFileSync(
        path.join(broker.layout.room, ".broker-status.json"),
        "utf-8",
      ),
    );
    expect(status.notices).toEqual([]);
    broker.close();
  });

  it("refuses to open a microsoft sign-in against a client id the pane already replaced", async () => {
    const broker = await makeBroker({ hostSettingsProbe: staleProbe });
    const flows: string[] = [];
    broker.loginManager.ensureFlow = async (_l, acct) => {
      flows.push(acct.address);
      return "http://localhost:9999/ms-fake";
    };
    loginRequest(broker, { address: "m@outlook.com" });
    await broker.runCycle({ syncNetwork: false });

    expect(flows).toEqual([]); // no browser flow against the stale id
    const rejected = broker.ledger
      .readAll()
      .filter((r) => r.op === "login_rejected");
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0]?.details as { reason?: string }).reason ?? "";
    expect(reason).toContain("…id-new");
    expect(reason).toContain("…cid"); // the id this server still runs with
    expect(reason).toContain("restart the MCP server");
    expect(reason).toContain("under another host"); // never assumes Claude Desktop
    broker.close();
  });

  it("an explicit --client-id overrides the stale-settings guard", async () => {
    const broker = await makeBroker({ hostSettingsProbe: staleProbe });
    const flows: string[] = [];
    broker.loginManager.ensureFlow = async (_l, acct) => {
      flows.push(acct.address);
      return "http://localhost:9999/ms-fake";
    };
    loginRequest(broker, { address: "m@outlook.com", client_id: "cid-x" });
    await broker.runCycle({ syncNetwork: false });

    expect(flows).toEqual(["m@outlook.com"]);
    expect(
      broker.ledger.readAll().filter((r) => r.op === "login_rejected"),
    ).toEqual([]);
    expect(
      broker.ledger.readAll().filter((r) => r.op === "login_started"),
    ).toHaveLength(1);
    broker.close();
  });
});
