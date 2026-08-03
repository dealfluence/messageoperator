import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanEnvValue, loadConfig } from "../src/config.js";
import { mailroomHome } from "../src/layout.js";
import { tmpHome } from "./helpers.js";

const saved = process.env.MAILROOM_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.MAILROOM_HOME;
  else process.env.MAILROOM_HOME = saved;
});

describe("mailroomHome hardening (Claude Desktop env templates)", () => {
  const fallback = path.join(os.homedir(), "mailroom");

  it("falls back when the env var is unset or empty", () => {
    delete process.env.MAILROOM_HOME;
    expect(mailroomHome()).toBe(fallback);
    process.env.MAILROOM_HOME = "   ";
    expect(mailroomHome()).toBe(fallback);
  });

  it("falls back on an unresolved ${...} template passed through literally", () => {
    process.env.MAILROOM_HOME = "${user_config.mailroom_home}";
    expect(mailroomHome()).toBe(fallback);
    process.env.MAILROOM_HOME = "${HOME}/mailroom";
    expect(mailroomHome()).toBe(fallback);
  });

  it("falls back on relative paths (cwd may be / under Claude Desktop)", () => {
    process.env.MAILROOM_HOME = "mailroom-state";
    expect(mailroomHome()).toBe(fallback);
  });

  it("expands ~ and accepts absolute paths", () => {
    process.env.MAILROOM_HOME = "~/custom-mailroom";
    expect(mailroomHome()).toBe(path.join(os.homedir(), "custom-mailroom"));
    const abs = tmpHome();
    process.env.MAILROOM_HOME = abs;
    expect(mailroomHome()).toBe(abs);
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
    // ambient keychain password exists without MAILROOM_GMAIL_ADDRESS —
    // the password must NOT bind to it
    const cfg = makeConfig({
      accounts: [{ provider: "gmail", address: "attacker@gmail.com" }],
    });
    const env = { MAILROOM_GMAIL_APP_PW: "abcdabcdabcdabcd" };
    expect(gmailAppPassword(layout, cfg, "attacker@gmail.com", env)).toBeNull();
    // with the env address set, it binds only to that address
    const named = { ...env, MAILROOM_GMAIL_ADDRESS: "me@gmail.com" };
    expect(
      gmailAppPassword(layout, cfg, "attacker@gmail.com", named),
    ).toBeNull();
    expect(gmailAppPassword(layout, cfg, "me@gmail.com", named)).toBe(
      "abcdabcdabcdabcd",
    );
  });

  it("rejects malformed env addresses that would become directory names", () => {
    const cfg = loadConfig(path.join(tmpHome(), "none.json"), {
      MAILROOM_GMAIL_ADDRESS: "first..last@gmail.com",
      MAILROOM_MS_ADDRESS: "mailto:user@x com/../evil",
    });
    expect(cfg.accounts).toEqual([]);
  });
});

describe("config env merge ignores unresolved templates", () => {
  it("does not create accounts or flip dry_run from template garbage", () => {
    const cfg = loadConfig(path.join(tmpHome(), "none.json"), {
      MAILROOM_GMAIL_ADDRESS: "${user_config.gmail_address}",
      MAILROOM_MS_ADDRESS: "${user_config.microsoft_address}",
      MAILROOM_MS_CLIENT_ID: "${user_config.microsoft_client_id}",
      MAILROOM_DRY_RUN: "${user_config.dry_run}",
      MAILROOM_ALLOWED_RECIPIENT_DOMAINS:
        "${user_config.allowed_recipient_domains}",
    });
    expect(cfg.accounts).toEqual([]);
    expect(cfg.dry_run).toBe(true);
    expect(cfg.policy.allowed_recipient_domains).toEqual([]);
  });
});
