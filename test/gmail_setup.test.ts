import { describe, expect, it, afterEach } from "vitest";

import { GmailAuthError } from "../src/gmail.js";
import { GmailSetupFlow } from "../src/gmail_setup.js";

const ADDRESS = "second@gmail.com";

/** POST the wizard form the way a browser would. */
async function postPassword(url: string, password: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
  });
}

describe("gmail setup flow", () => {
  const flows: GmailSetupFlow[] = [];

  function makeFlow(): GmailSetupFlow {
    const flow = new GmailSetupFlow();
    flows.push(flow);
    return flow;
  }

  afterEach(() => {
    for (const flow of flows.splice(0)) flow.closeAll();
  });

  it("serves a wizard page for the address on a nonce-protected loopback URL", async () => {
    const flow = makeFlow();
    const url = await flow.ensureFlow(ADDRESS, { verify: async () => {} });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup\/[0-9a-f]{32,}$/);
    expect(flow.pendingUrls()).toEqual({ [ADDRESS]: url });

    const page = await (await fetch(url)).text();
    expect(page).toContain(ADDRESS);
    expect(page).toContain("https://myaccount.google.com/apppasswords");
    expect(page).toContain("2-Step Verification");
    expect(page).toContain("<form"); // the paste-it-here step
  });

  it("rejects a wrong nonce outright", async () => {
    const flow = makeFlow();
    const url = await flow.ensureFlow(ADDRESS, { verify: async () => {} });
    const origin = new URL(url).origin;
    const bad = await fetch(`${origin}/setup/${"0".repeat(32)}`);
    expect(bad.status).toBe(404);
    const badPost = await postPassword(
      `${origin}/setup/${"0".repeat(32)}`,
      "abcdabcdabcdabcd",
    );
    expect(badPost.status).toBe(404);
    expect(flow.outcome(ADDRESS)).toBeUndefined(); // flow still pending
  });

  it("returns the same URL while a flow is already pending", async () => {
    const flow = makeFlow();
    const first = await flow.ensureFlow(ADDRESS, { verify: async () => {} });
    const second = await flow.ensureFlow(ADDRESS, { verify: async () => {} });
    expect(second).toBe(first);
  });

  it("verifies, strips Google's display spaces, stores, and closes on success", async () => {
    const flow = makeFlow();
    const verified: string[] = [];
    const stored: Array<[string, string]> = [];
    const url = await flow.ensureFlow(ADDRESS, {
      verify: async (address, password) => {
        verified.push(`${address}:${password}`);
      },
      onStored: (address, password) => {
        stored.push([address, password]);
      },
    });

    const resp = await postPassword(url, "abcd efgh ijkl mnop");
    const page = await resp.text();
    expect(resp.status).toBe(200);
    expect(page.toLowerCase()).toContain("connected");
    expect(verified).toEqual([`${ADDRESS}:abcdefghijklmnop`]);
    expect(stored).toEqual([[ADDRESS, "abcdefghijklmnop"]]);
    expect(flow.outcome(ADDRESS)).toBe("ok");
    expect(flow.pendingUrls()).toEqual({}); // listener closed
  });

  it("keeps the page alive for a retry when Gmail refuses the password", async () => {
    const flow = makeFlow();
    let attempt = 0;
    const stored: string[] = [];
    const url = await flow.ensureFlow(ADDRESS, {
      verify: async () => {
        attempt += 1;
        if (attempt === 1)
          throw new GmailAuthError(
            "[AUTHENTICATIONFAILED] Invalid credentials",
          );
      },
      onStored: (_address, password) => {
        stored.push(password);
      },
    });

    const refusal = await postPassword(url, "wrongwrongwrongw");
    const refusalPage = await refusal.text();
    expect(refusalPage).toContain("refused");
    expect(refusalPage).toContain("<form"); // retry on the same page
    expect(stored).toEqual([]);
    expect(flow.pendingUrls()).toEqual({ [ADDRESS]: url }); // still pending

    const retry = await postPassword(url, "abcdefghijklmnop");
    expect((await retry.text()).toLowerCase()).toContain("connected");
    expect(stored).toEqual(["abcdefghijklmnop"]);
    expect(flow.outcome(ADDRESS)).toBe("ok");
  });

  it("rejects non-ASCII input (dead-key artifacts) without calling verify", async () => {
    const flow = makeFlow();
    const verified: string[] = [];
    const url = await flow.ensureFlow(ADDRESS, {
      verify: async (_a, password) => {
        verified.push(password);
      },
    });
    const resp = await postPassword(url, "abcdefghijklmnoà");
    const page = await resp.text();
    expect(page).toContain("<form");
    expect(page.toLowerCase()).toContain("ascii");
    expect(verified).toEqual([]);
    expect(flow.pendingUrls()).toEqual({ [ADDRESS]: url });
  });

  it("stores with a warning when Gmail is unreachable (non-auth failure)", async () => {
    const flow = makeFlow();
    const stored: string[] = [];
    const url = await flow.ensureFlow(ADDRESS, {
      verify: async () => {
        throw new Error("ECONNREFUSED");
      },
      onStored: (_address, password) => {
        stored.push(password);
      },
    });
    const page = await (await postPassword(url, "abcdefghijklmnop")).text();
    expect(page.toLowerCase()).toContain("could not verify");
    expect(stored).toEqual(["abcdefghijklmnop"]);
    expect(flow.outcome(ADDRESS)).toBe("ok_unverified");
    expect(flow.pendingUrls()).toEqual({});
  });

  it("surfaces a storage failure on the page instead of dying, and allows retry", async () => {
    const flow = makeFlow();
    let attempt = 0;
    const url = await flow.ensureFlow(ADDRESS, {
      verify: async () => {},
      onStored: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("EACCES: permission denied");
      },
    });

    const failed = await postPassword(url, "abcdefghijklmnop");
    const failedPage = await failed.text();
    expect(failedPage).toContain("NOT stored");
    expect(failedPage).toContain("<form"); // retry form
    expect(flow.pendingUrls()).toEqual({ [ADDRESS]: url }); // still alive

    const retry = await postPassword(url, "abcdefghijklmnop");
    expect((await retry.text()).toLowerCase()).toContain("connected");
    expect(flow.outcome(ADDRESS)).toBe("ok");
  });

  it("surfaces a REJECTED async store the same way (keychain writes are async)", async () => {
    const flow = makeFlow();
    let attempt = 0;
    const url = await flow.ensureFlow(ADDRESS, {
      verify: async () => {},
      // what a locked keychain / missing PowerShell actually looks like: the
      // rejection lands after handleSubmit has already awaited it
      onStored: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("keychain write failed: exit 36");
      },
    });

    const failedPage = await (
      await postPassword(url, "abcdefghijklmnop")
    ).text();
    expect(failedPage).toContain("NOT stored");
    expect(flow.pendingUrls()).toEqual({ [ADDRESS]: url }); // retryable

    const retry = await postPassword(url, "abcdefghijklmnop");
    expect((await retry.text()).toLowerCase()).toContain("connected");
    expect(flow.outcome(ADDRESS)).toBe("ok");
  });

  it("closeAll tears down pending listeners", async () => {
    const flow = makeFlow();
    const url = await flow.ensureFlow(ADDRESS, { verify: async () => {} });
    flow.closeAll();
    expect(flow.pendingUrls()).toEqual({});
    await expect(fetch(url)).rejects.toThrow();
  });
});
