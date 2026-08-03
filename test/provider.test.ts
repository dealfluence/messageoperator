import { describe, expect, it } from "vitest";

import { detectProvider } from "../src/provider.js";

function mx(...exchanges: string[]) {
  return async () =>
    exchanges.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
}

const neverResolves = async (): Promise<never> => {
  throw new Error("resolveMx must not be called for well-known domains");
};

describe("detectProvider", () => {
  it("knows well-known domains without touching DNS", async () => {
    expect(await detectProvider("a@gmail.com", neverResolves)).toBe("gmail");
    expect(await detectProvider("a@googlemail.com", neverResolves)).toBe(
      "gmail",
    );
    expect(await detectProvider("a@outlook.com", neverResolves)).toBe(
      "microsoft",
    );
    expect(await detectProvider("a@hotmail.com", neverResolves)).toBe(
      "microsoft",
    );
    expect(await detectProvider("a@live.com", neverResolves)).toBe("microsoft");
  });

  it("detects Google Workspace custom domains by MX", async () => {
    expect(
      await detectProvider(
        "jane@mybusiness.fi",
        mx("ASPMX.L.GOOGLE.COM.", "alt1.aspmx.l.google.com"),
      ),
    ).toBe("gmail");
  });

  it("detects Microsoft 365 custom domains by MX", async () => {
    expect(
      await detectProvider(
        "jane@mybusiness.fi",
        mx("mybusiness-fi.mail.protection.outlook.com"),
      ),
    ).toBe("microsoft");
  });

  it("returns null for unknown MX hosts", async () => {
    expect(
      await detectProvider(
        "jane@mybusiness.fi",
        mx("mx1.privateemail.example"),
      ),
    ).toBeNull();
  });

  it("returns null when DNS resolution fails or the address is malformed", async () => {
    const failing = async (): Promise<never> => {
      throw new Error("ENOTFOUND");
    };
    expect(await detectProvider("jane@mybusiness.fi", failing)).toBeNull();
    expect(await detectProvider("not-an-address", failing)).toBeNull();
  });

  it("is not fooled by lookalike suffixes", async () => {
    expect(
      await detectProvider("a@evil.example", mx("notgoogle.com")),
    ).toBeNull();
    expect(
      await detectProvider("a@evil.example", mx("fakegoogle.com.attacker.net")),
    ).toBeNull();
  });
});
