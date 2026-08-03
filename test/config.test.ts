import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  accountsFor,
  appendAccountToFile,
  ensureDefaultConfig,
  findAccount,
  loadConfig,
  ownAddresses,
} from "../src/config.js";
import { tmpHome } from "./helpers.js";

function configPath(): string {
  return path.join(tmpHome(), "config.json");
}

describe("config", () => {
  it("creates a default config file once", () => {
    const p = configPath();
    ensureDefaultConfig(p);
    expect(fs.existsSync(p)).toBe(true);
    const cfg = loadConfig(p, {});
    expect(cfg.dry_run).toBe(true);
    expect(cfg.serve_broker).toBe("boundary");
    expect(cfg.accounts).toEqual([]);
  });

  it("parses body_cache_mb with a 50MB default", () => {
    const p = configPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ body_cache_mb: 250 }));
    expect(loadConfig(p, {}).body_cache_mb).toBe(250);
    fs.writeFileSync(p, JSON.stringify({}));
    expect(loadConfig(p, {}).body_cache_mb).toBe(50);
    fs.writeFileSync(p, JSON.stringify({ body_cache_mb: "junk" }));
    expect(loadConfig(p, {}).body_cache_mb).toBe(50);
    fs.writeFileSync(p, JSON.stringify({ body_cache_mb: -3 }));
    expect(loadConfig(p, {}).body_cache_mb).toBe(50);
  });

  it("parses a multi-account list with per-provider entries", () => {
    const p = configPath();
    fs.writeFileSync(
      p,
      JSON.stringify({
        dry_run: false,
        accounts: [
          { provider: "gmail", address: "A@Gmail.com" },
          { provider: "gmail", address: "second@gmail.com" },
          {
            provider: "microsoft",
            address: "m@outlook.com",
            client_id: "cid-1",
          },
          { provider: "bogus", address: "x@y.com" },
          { provider: "gmail", address: "no-at-sign" },
          { provider: "gmail", address: "a@gmail.com" }, // dup of first (case)
        ],
      }),
    );
    const cfg = loadConfig(p, {});
    expect(cfg.accounts).toHaveLength(3);
    expect(accountsFor(cfg, "gmail").map((a) => a.address)).toEqual([
      "a@gmail.com",
      "second@gmail.com",
    ]);
    expect(findAccount(cfg, "M@outlook.com")?.client_id).toBe("cid-1");
    expect([...ownAddresses(cfg)].sort()).toEqual([
      "a@gmail.com",
      "m@outlook.com",
      "second@gmail.com",
    ]);
  });

  it("merges env-declared accounts without duplicating file entries", () => {
    const p = configPath();
    fs.writeFileSync(
      p,
      JSON.stringify({
        accounts: [{ provider: "gmail", address: "a@gmail.com" }],
      }),
    );
    const cfg = loadConfig(p, {
      MAILROOM_GMAIL_ADDRESS: "a@gmail.com",
      MAILROOM_MS_ADDRESS: "m@outlook.com",
      MAILROOM_MS_CLIENT_ID: "cid-env",
    });
    expect(cfg.accounts).toHaveLength(2);
    expect(findAccount(cfg, "m@outlook.com")?.client_id).toBe("cid-env");
  });

  it("shares an env client_id with file-configured microsoft accounts", () => {
    const p = configPath();
    fs.writeFileSync(
      p,
      JSON.stringify({
        accounts: [{ provider: "microsoft", address: "m@outlook.com" }],
      }),
    );
    const cfg = loadConfig(p, { MAILROOM_MS_CLIENT_ID: "shared-cid" });
    expect(findAccount(cfg, "m@outlook.com")?.client_id).toBe("shared-cid");
  });

  it("lets env dry_run override the file (extension settings win)", () => {
    const p = configPath();
    fs.writeFileSync(p, JSON.stringify({ dry_run: true }));
    expect(loadConfig(p, { MAILROOM_DRY_RUN: "false" }).dry_run).toBe(false);
    expect(loadConfig(p, { MAILROOM_DRY_RUN: "true" }).dry_run).toBe(true);
    expect(loadConfig(p, {}).dry_run).toBe(true);
  });

  it("merges allowed recipient domains from env", () => {
    const p = configPath();
    fs.writeFileSync(
      p,
      JSON.stringify({ policy: { allowed_recipient_domains: ["a.com"] } }),
    );
    const cfg = loadConfig(p, {
      MAILROOM_ALLOWED_RECIPIENT_DOMAINS: "@B.com, a.com",
    });
    expect(cfg.policy.allowed_recipient_domains.sort()).toEqual([
      "a.com",
      "b.com",
    ]);
  });

  it("persists agent-added accounts to the file, deduplicating by address", async () => {
    const { persistAccount, defaultMsClientId } =
      await import("../src/config.js");
    const p = configPath();
    fs.writeFileSync(
      p,
      JSON.stringify({
        dry_run: false,
        accounts: [
          {
            provider: "microsoft",
            address: "m@outlook.com",
            client_id: "cid-1",
          },
        ],
      }),
    );
    expect(
      persistAccount(p, { provider: "gmail", address: "New@Gmail.com" }),
    ).toBe(true);
    expect(
      persistAccount(p, { provider: "gmail", address: "new@gmail.com" }),
    ).toBe(false); // dup
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(data.dry_run).toBe(false); // other settings untouched
    expect(data.accounts).toHaveLength(2);
    expect(data.accounts[1]).toEqual({
      provider: "gmail",
      address: "new@gmail.com",
    });

    const cfg = loadConfig(p, {});
    expect(defaultMsClientId(cfg, {})).toBe("cid-1"); // unique existing id
    expect(defaultMsClientId(cfg, { MAILROOM_MS_CLIENT_ID: "cid-env" })).toBe(
      "cid-env",
    );
  });

  it("survives a missing or corrupt file", () => {
    const cfg = loadConfig(path.join(tmpHome(), "nope.json"), {});
    expect(cfg.dry_run).toBe(true);
    const p = configPath();
    fs.writeFileSync(p, "{corrupt");
    expect(loadConfig(p, {}).serve_broker).toBe("boundary");
  });
});

describe("appendAccountToFile", () => {
  it("appends a new account and preserves the rest of the file", () => {
    const p = configPath();
    ensureDefaultConfig(p);
    fs.writeFileSync(
      p,
      JSON.stringify({
        _readme: ["keep me"],
        dry_run: false,
        accounts: [{ provider: "gmail", address: "a@gmail.com" }],
      }),
    );
    expect(
      appendAccountToFile(p, {
        provider: "gmail",
        address: "Second@Gmail.com",
      }),
    ).toBe(true);
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(data._readme).toEqual(["keep me"]);
    expect(data.dry_run).toBe(false);
    expect(data.accounts).toEqual([
      { provider: "gmail", address: "a@gmail.com" },
      { provider: "gmail", address: "second@gmail.com" }, // lowercased
    ]);
    const cfg = loadConfig(p, {});
    expect(accountsFor(cfg, "gmail").map((a) => a.address)).toEqual([
      "a@gmail.com",
      "second@gmail.com",
    ]);
  });

  it("keeps client_id for microsoft accounts and refuses duplicates", () => {
    const p = configPath();
    ensureDefaultConfig(p);
    expect(
      appendAccountToFile(p, {
        provider: "microsoft",
        address: "m@outlook.com",
        client_id: "cid",
      }),
    ).toBe(true);
    expect(
      appendAccountToFile(p, {
        provider: "microsoft",
        address: "M@Outlook.com",
        client_id: "other",
      }),
    ).toBe(false); // same address, case-insensitive
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(data.accounts).toEqual([
      { provider: "microsoft", address: "m@outlook.com", client_id: "cid" },
    ]);
  });

  it("creates the accounts list when the file is missing or has none", () => {
    const p = configPath();
    expect(
      appendAccountToFile(p, { provider: "gmail", address: "a@gmail.com" }),
    ).toBe(true);
    expect(loadConfig(p, {}).accounts).toHaveLength(1);
  });
});
