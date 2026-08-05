import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanEnvValue, loadConfig } from "../src/config.js";
import { defaultStateHome, stateHome } from "../src/layout.js";
import { tmpHome } from "./helpers.js";

const saved = process.env.MESSAGEOPERATOR_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.MESSAGEOPERATOR_HOME;
  else process.env.MESSAGEOPERATOR_HOME = saved;
});

describe("stateHome hardening (Claude Desktop env templates)", () => {
  // whatever the probe decides on this machine — the guard paths must all
  // land on the same default
  const fallback = defaultStateHome();

  it("falls back when the env var is unset or empty", () => {
    delete process.env.MESSAGEOPERATOR_HOME;
    expect(stateHome()).toBe(fallback);
    process.env.MESSAGEOPERATOR_HOME = "   ";
    expect(stateHome()).toBe(fallback);
  });

  it("falls back on an unresolved ${...} template passed through literally", () => {
    process.env.MESSAGEOPERATOR_HOME = "${user_config.state_home}";
    expect(stateHome()).toBe(fallback);
    process.env.MESSAGEOPERATOR_HOME = "${HOME}/messageoperator";
    expect(stateHome()).toBe(fallback);
  });

  it("falls back on relative paths (cwd may be / under Claude Desktop)", () => {
    process.env.MESSAGEOPERATOR_HOME = "messageoperator-state";
    expect(stateHome()).toBe(fallback);
  });

  it("expands ~ and accepts absolute paths", () => {
    process.env.MESSAGEOPERATOR_HOME = "~/custom-state";
    expect(stateHome()).toBe(path.join(os.homedir(), "custom-state"));
    const abs = tmpHome();
    process.env.MESSAGEOPERATOR_HOME = abs;
    expect(stateHome()).toBe(abs);
  });
});

describe("cleanEnvValue", () => {
  it("treats unset, empty, and template-literal values as absent", () => {
    expect(cleanEnvValue({}, "X")).toBeUndefined();
    expect(cleanEnvValue({ X: "" }, "X")).toBeUndefined();
    expect(cleanEnvValue({ X: "  " }, "X")).toBeUndefined();
    expect(cleanEnvValue({ X: "${user_config.x}" }, "X")).toBeUndefined();
    expect(cleanEnvValue({ X: "real-value" }, "X")).toBe("real-value");
  });
});

describe("ambient gmail password binding", () => {
  it("never attaches the env password to an account the env does not name", async () => {
    const { gmailAppPassword } = await import("../src/creds.js");
    const { makeLayout, makeConfig } = await import("./helpers.js");
    const layout = makeLayout();
    // attacker@ is the SOLE configured gmail account (agent-added), and an
    // ambient keychain password exists without MESSAGEOPERATOR_GMAIL_ADDRESS —
    // the password must NOT bind to it
    const cfg = makeConfig({
      accounts: [{ provider: "gmail", address: "attacker@gmail.com" }],
    });
    const env = { MESSAGEOPERATOR_GMAIL_APP_PW: "abcdabcdabcdabcd" };
    expect(gmailAppPassword(layout, cfg, "attacker@gmail.com", env)).toBeNull();
    // with the env address set, it binds only to that address
    const named = { ...env, MESSAGEOPERATOR_GMAIL_ADDRESS: "me@gmail.com" };
    expect(
      gmailAppPassword(layout, cfg, "attacker@gmail.com", named),
    ).toBeNull();
    expect(gmailAppPassword(layout, cfg, "me@gmail.com", named)).toBe(
      "abcdabcdabcdabcd",
    );
  });

  it("rejects malformed env addresses that would become directory names", () => {
    const cfg = loadConfig(path.join(tmpHome(), "none.json"), {
      MESSAGEOPERATOR_GMAIL_ADDRESS: "first..last@gmail.com",
      MESSAGEOPERATOR_MS_ADDRESS: "mailto:user@x com/../evil",
    });
    expect(cfg.accounts).toEqual([]);
  });
});

describe("config env merge ignores unresolved templates", () => {
  it("does not create accounts or flip dry_run from template garbage", () => {
    const cfg = loadConfig(path.join(tmpHome(), "none.json"), {
      MESSAGEOPERATOR_GMAIL_ADDRESS: "${user_config.gmail_address}",
      MESSAGEOPERATOR_MS_ADDRESS: "${user_config.microsoft_address}",
      MESSAGEOPERATOR_MS_CLIENT_ID: "${user_config.microsoft_client_id}",
      MESSAGEOPERATOR_DRY_RUN: "${user_config.dry_run}",
      MESSAGEOPERATOR_ALLOWED_RECIPIENT_DOMAINS:
        "${user_config.allowed_recipient_domains}",
    });
    expect(cfg.accounts).toEqual([]);
    expect(cfg.dry_run).toBe(true);
    expect(cfg.policy.allowed_recipient_domains).toEqual([]);
  });
});
