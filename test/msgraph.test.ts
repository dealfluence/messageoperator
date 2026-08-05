import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  authState,
  fetchBody,
  GraphHTTPError,
  sync,
  type RequestFn,
} from "../src/msgraph.js";
import { Rejection } from "../src/intents.js";
import {
  clearSecretCache,
  readSealedFile,
  writeSealedFile,
} from "../src/secrets.js";
import {
  makeConfig,
  makeIndex,
  makeLayout,
  makeLedger,
  sampleEml,
} from "./helpers.js";

const ACCT = {
  provider: "microsoft" as const,
  address: "m@outlook.com",
  client_id: "cid",
};

interface FakeGraphOpts {
  messages?: Record<string, Buffer>;
  pages?: any[][];
  deltaPages?: Record<string, any[][]>;
  expireDelta?: boolean;
  /** pages served by GET /me/messages (the historical backfill) */
  history?: any[][];
}

const FOLDER_IDS: Record<string, string> = {
  inbox: "fid-inbox",
  sentitems: "fid-sentitems",
  archive: "fid-archive",
  drafts: "fid-drafts",
  junkemail: "fid-junkemail",
  deleteditems: "fid-deleteditems",
};

/** Fake Graph backend mirroring the Python test double. */
function fakeGraph(opts: FakeGraphOpts) {
  const calls: string[] = [];
  const requestFn: RequestFn = async (method, url) => {
    calls.push(url);
    if (url.includes("/$value")) {
      const id = decodeURIComponent(
        url.split("/messages/")[1]!.split("/$value")[0]!,
      );
      return {
        status: 200,
        body: opts.messages?.[id] ?? sampleEml({ messageId: `<${id}@x>` }),
      };
    }
    if (url.includes("/delta")) {
      if (url.startsWith("https://delta.example/")) {
        if (opts.expireDelta) {
          throw new GraphHTTPError(410, method, url, "resyncRequired");
        }
        const key = url.replace("https://delta.example/", "");
        const pages = opts.deltaPages?.[key] ?? [[]];
        return pageResponse(pages, url, key);
      }
      const remote = url.split("/mailFolders/")[1]!.split("/")[0]!;
      const pages = opts.pages ?? [[]];
      return pageResponse(pages, url, remote);
    }
    const wellKnown = /\/me\/mailFolders\/([a-z]+)\?/.exec(url)?.[1];
    if (wellKnown) {
      const id = FOLDER_IDS[wellKnown];
      if (!id) throw new GraphHTTPError(404, method, url, "no such folder");
      return { status: 200, body: Buffer.from(JSON.stringify({ id })) };
    }
    if (url.includes("/me/messages?")) {
      return pageResponse(opts.history ?? [[]], url, "history", {
        plainPaging: true,
      });
    }
    throw new GraphHTTPError(404, method, url, "unknown fake endpoint");
  };

  function pageResponse(
    pages: any[][],
    url: string,
    remote: string,
    o: { plainPaging?: boolean } = {},
  ) {
    const pageParam = new URL(url).searchParams.get("fakepage");
    const i = pageParam ? Number(pageParam) : 0;
    const value = pages[i] ?? [];
    const isLast = i >= pages.length - 1;
    const body: any = { value };
    if (isLast) {
      if (!o.plainPaging) {
        body["@odata.deltaLink"] = `https://delta.example/${remote}`;
      }
    } else {
      const next = new URL(url);
      next.searchParams.set("fakepage", String(i + 1));
      body["@odata.nextLink"] = next.toString();
    }
    return { status: 200, body: Buffer.from(JSON.stringify(body)) };
  }

  return { requestFn, calls };
}

function historyItem(
  id: string,
  folder: keyof typeof FOLDER_IDS,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    receivedDateTime: "2025-03-01T10:00:00Z",
    subject: `hist ${id}`,
    from: { emailAddress: { name: "Old Sender", address: "old@x.com" } },
    toRecipients: [{ emailAddress: { address: "m@outlook.com" } }],
    internetMessageId: `<${id}@x>`,
    parentFolderId: FOLDER_IDS[folder],
    ...extra,
  };
}

const getToken = async () => "tok";

describe("graph delta sync", () => {
  it("walks the initial window, stores messages, and saves the delta link", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    const { requestFn } = fakeGraph({
      pages: [
        [{ id: "id-1", receivedDateTime: "2026-07-01T00:00:00Z" }],
        [{ id: "id-2", receivedDateTime: "2026-07-02T00:00:00Z" }],
      ],
      messages: {
        "id-1": sampleEml({ subject: "one", messageId: "<1@x>" }),
        "id-2": sampleEml({ subject: "two", messageId: "<2@x>" }),
      },
    });

    await sync(layout, index, ledger, cfg, new Set(), { requestFn, getToken });

    expect(
      index
        .allMessages()
        .map((m) => m.subject)
        .sort(),
    ).toEqual(["one", "two"]);
    expect(index.getState("graph:m@outlook.com:inbox:delta")).toBe(
      "https://delta.example/inbox",
    );
    expect(index.graphIsSeen("id-1")).toBe(true);
  });

  it("polls the stored delta link and only fetches unseen ids", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    index.setState(
      "graph:m@outlook.com:inbox:delta",
      "https://delta.example/inbox",
    );
    index.setState(
      "graph:m@outlook.com:sentitems:delta",
      "https://delta.example/sentitems",
    );
    index.graphMarkSeen("already");
    const { requestFn, calls } = fakeGraph({
      deltaPages: {
        inbox: [
          [
            { id: "already" },
            { id: "fresh", receivedDateTime: "2026-07-03T00:00:00Z" },
          ],
        ],
        sentitems: [[]],
      },
      messages: { fresh: sampleEml({ subject: "fresh", messageId: "<f@x>" }) },
    });

    await sync(layout, index, ledger, cfg, new Set(), { requestFn, getToken });

    expect(index.allMessages().map((m) => m.subject)).toEqual(["fresh"]);
    expect(calls.filter((u) => u.includes("/$value"))).toHaveLength(1);
  });

  it("falls back to a fresh walk when the delta link has expired (410)", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    index.setState(
      "graph:m@outlook.com:inbox:delta",
      "https://delta.example/inbox",
    );
    index.setState(
      "graph:m@outlook.com:sentitems:delta",
      "https://delta.example/sentitems",
    );
    const { requestFn } = fakeGraph({
      expireDelta: true,
      pages: [[{ id: "rewalked", receivedDateTime: "2026-07-04T00:00:00Z" }]],
      messages: {
        rewalked: sampleEml({ subject: "rewalked", messageId: "<r@x>" }),
      },
    });

    await sync(layout, index, ledger, cfg, new Set(), { requestFn, getToken });

    // both folders re-walked; both stored one message each name (sha dedup collapses identical)
    expect(index.allMessages().some((m) => m.subject === "rewalked")).toBe(
      true,
    );
  });

  it("ledgers @removed entries without touching local copies", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    const { requestFn } = fakeGraph({
      pages: [[{ id: "gone", "@removed": { reason: "deleted" } }]],
    });

    await sync(layout, index, ledger, cfg, new Set(), { requestFn, getToken });

    const removed = ledger.readAll().filter((r) => r.op === "remote_removed");
    expect(removed.length).toBeGreaterThan(0);
    expect(index.allMessages()).toEqual([]);
  });

  it("re-homes a message archived outside Message Operator to Archive", async () => {
    // Field case: the user archives an inbox message in Outlook. The INBOX
    // delta reports it as @removed — the only place Graph says it left the
    // inbox — and the room used to keep showing it in the inbox forever,
    // because the history backfill sweeps each message once and never
    // revisits an already-indexed one.
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    index.insertMessage({
      sha: "ms:left-inbox",
      account: ACCT.address,
      folder: "INBOX",
      filename: "1.eml",
      path: `accounts/${ACCT.address}/mail/INBOX/cur/1.eml`,
      date: "Mon, 06 Jul 2026 10:00:00 +0000",
      epoch: 1700000000,
      from: "x@example.com",
      to: ACCT.address,
      subject: "archived in outlook",
      body: "b",
      gmailId: "left-inbox",
    });
    const { requestFn } = fakeGraph({
      pages: [[{ id: "left-inbox", "@removed": { reason: "changed" } }]],
    });

    await sync(layout, index, ledger, cfg, new Set(), { requestFn, getToken });

    expect(index.getBySha("ms:left-inbox")?.folder).toBe("Archive");
    // the file has not moved yet: the broker does that, and the row being out
    // of step with its path is exactly the signal it looks for
    expect(index.rowsWithMisplacedFiles()).toMatchObject([
      { sha: "ms:left-inbox", folder: "Archive" },
    ]);
  });

  it("skips accounts with no token and keeps going", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    const { requestFn, calls } = fakeGraph({});

    await sync(layout, index, ledger, cfg, new Set(), {
      requestFn,
      getToken: async () => null,
    });

    expect(calls).toEqual([]);
  });
});

describe("graph history backfill", () => {
  it("indexes history metadata-only with folder mapping; junk and trash skipped", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    const { requestFn } = fakeGraph({
      history: [
        [
          historyItem("h1", "inbox"),
          historyItem("h2", "archive"),
          historyItem("h3", "junkemail"),
        ],
        [historyItem("h4", "sentitems"), historyItem("h5", "deleteditems")],
      ],
    });

    await sync(layout, index, ledger, cfg, new Set(), { requestFn, getToken });

    const rows = index.allMessages();
    expect(rows.map((r) => r.gmailId).sort()).toEqual(["h1", "h2", "h4"]);
    expect(rows.every((r) => r.metaOnly)).toBe(true);
    const h1 = rows.find((r) => r.gmailId === "h1");
    expect(h1?.folder).toBe("INBOX");
    expect(h1?.labels).toEqual(["INBOX"]);
    expect(h1?.from).toBe("Old Sender <old@x.com>");
    expect(h1?.rfcMessageId).toBe("<h1@x>");
    expect(rows.find((r) => r.gmailId === "h2")?.folder).toBe("Archive");
    expect(rows.find((r) => r.gmailId === "h4")?.folder).toBe("Sent");

    const st = index.getSyncState("m@outlook.com", "graph:history");
    expect(st?.status).toBe("caught_up");
    expect(st?.cursor).toBeNull();
  });

  it("skips messages the delta sync already stored with a body", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    const { requestFn } = fakeGraph({
      pages: [[{ id: "id-1", receivedDateTime: "2026-07-01T00:00:00Z" }]],
      messages: { "id-1": sampleEml({ subject: "full", messageId: "<1@x>" }) },
      history: [[historyItem("id-1", "inbox"), historyItem("h2", "archive")]],
    });

    await sync(layout, index, ledger, cfg, new Set(), { requestFn, getToken });

    const rows = index.allMessages();
    expect(rows).toHaveLength(2);
    const full = rows.find((r) => r.subject === "full");
    expect(full?.metaOnly).toBeUndefined();
    expect(rows.filter((r) => r.gmailId === "h2")).toHaveLength(1);
  });

  it("is time-boxed: stops at the deadline, resumes from the stored cursor", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    const { requestFn, calls } = fakeGraph({
      history: [
        [historyItem("h1", "inbox")],
        [historyItem("h2", "inbox")],
        [historyItem("h3", "inbox")],
      ],
    });
    let clock = 0;
    const ticking: RequestFn = async (method, url, token, o) => {
      if (url.includes("/me/messages?")) clock += 1000;
      return requestFn(method, url, token, o);
    };

    // budget of 1500 fake-ms: page 1 (t->1000), page 2 (t->2000), stop
    await sync(layout, index, ledger, cfg, new Set(), {
      requestFn: ticking,
      getToken,
      historyDeadline: 1500,
      now: () => clock,
    });
    expect(index.allMessages()).toHaveLength(2);
    let st = index.getSyncState("m@outlook.com", "graph:history");
    expect(st?.status).toBe("in_progress");
    expect(st?.cursor).toContain("fakepage=2");

    await sync(layout, index, ledger, cfg, new Set(), {
      requestFn: ticking,
      getToken,
      historyDeadline: clock + 5000,
      now: () => clock,
    });
    expect(index.allMessages()).toHaveLength(3);
    st = index.getSyncState("m@outlook.com", "graph:history");
    expect(st?.status).toBe("caught_up");
    // the first two pages were never re-fetched
    const historyCalls = calls.filter((u) => u.includes("/me/messages?"));
    expect(historyCalls.filter((u) => !u.includes("fakepage"))).toHaveLength(1);
    expect(historyCalls.filter((u) => u.includes("fakepage=1"))).toHaveLength(
      1,
    );
  });

  it("does nothing once caught up", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const cfg = makeConfig({ accounts: [ACCT] });
    const { requestFn, calls } = fakeGraph({
      history: [[historyItem("h1", "inbox")]],
    });
    await sync(layout, index, ledger, cfg, new Set(), { requestFn, getToken });
    const after = calls.filter((u) => u.includes("/me/messages?")).length;
    await sync(layout, index, ledger, cfg, new Set(), { requestFn, getToken });
    expect(calls.filter((u) => u.includes("/me/messages?")).length).toBe(after);
  });
});

describe("on-demand body fetch (graph)", () => {
  it("downloads one raw MIME body by graph id", async () => {
    const layout = makeLayout();
    const raw = sampleEml({ subject: "old graph mail" });
    const { requestFn, calls } = fakeGraph({ messages: { "ms-1": raw } });
    const got = await fetchBody(layout, ACCT, "ms-1", {
      requestFn,
      getToken,
    });
    expect(got).toEqual(raw);
    expect(calls.some((u) => u.includes("/messages/ms-1/$value"))).toBe(true);
  });

  it("throws a Rejection when the account has no token", async () => {
    const layout = makeLayout();
    const { requestFn } = fakeGraph({});
    await expect(
      fetchBody(layout, ACCT, "ms-1", {
        requestFn,
        getToken: async () => null,
      }),
    ).rejects.toBeInstanceOf(Rejection);
  });
});

/**
 * The token cache holds refresh tokens — the only state in the tree that
 * cannot be rebuilt — so these tests drive the real MSAL cachePlugin hooks
 * through authState() and assert on what lands on disk. No network: MSAL only
 * reads its cache to answer getAllAccounts().
 */
describe("MSAL token cache at rest", () => {
  /**
   * Unified-schema cache with one signed-in account. The tenantProfiles entry
   * is what makes MSAL report the username (it is the tenant profile, not the
   * account entity, that account info is built from) and each profile really
   * is a JSON *string* in the serialized form — see Deserializer.
   */
  function cacheJson(username: string): string {
    return JSON.stringify({
      Account: {
        "uid.utid-login.microsoftonline.com-utid": {
          home_account_id: "uid.utid",
          environment: "login.microsoftonline.com",
          realm: "utid",
          local_account_id: "uid",
          username,
          client_info: "",
          authority_type: "MSSTS",
          tenantProfiles: [
            JSON.stringify({
              tenantId: "utid",
              localAccountId: "uid",
              username,
              isHomeTenant: true,
            }),
          ],
        },
      },
    });
  }

  it("is written encrypted, and read back", async () => {
    const layout = makeLayout();
    const enc = path.join(layout.credentials, "msal_token_cache.enc");
    await writeSealedFile(layout, enc, cacheJson("m@outlook.com"));

    expect(fs.readFileSync(enc, "utf-8")).not.toContain("m@outlook.com");
    expect(await authState(layout, ACCT)).toBe("ok");
    expect(
      await authState(layout, { ...ACCT, address: "other@outlook.com" }),
    ).toBe("needs_login");
  });

  it("migrates a plaintext cache from an older build and deletes it", async () => {
    const layout = makeLayout();
    const legacy = path.join(layout.credentials, "msal_token_cache.json");
    const enc = path.join(layout.credentials, "msal_token_cache.enc");
    const payload = cacheJson("m@outlook.com");
    fs.writeFileSync(legacy, payload);

    // the account still resolves, ...
    expect(await authState(layout, ACCT)).toBe("ok");
    // ... the plaintext copy is gone, and the ciphertext holds the same cache
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(enc)).toBe(true);
    expect(await readSealedFile(layout, enc)).toBe(payload);
    // and it keeps working from the encrypted copy alone
    clearSecretCache();
    expect(await authState(layout, ACCT)).toBe("ok");
  });

  it("treats an undecryptable cache as absent instead of throwing", async () => {
    const layout = makeLayout();
    const enc = path.join(layout.credentials, "msal_token_cache.enc");
    await writeSealedFile(layout, enc, cacheJson("m@outlook.com"));
    const blob = fs.readFileSync(enc);
    blob[blob.length - 1] = (blob.at(-1) ?? 0) ^ 0xff;
    fs.writeFileSync(enc, blob);

    expect(await authState(layout, ACCT)).toBe("needs_login");
    // the damaged file is left in place: only a real token write replaces it
    expect(fs.existsSync(enc)).toBe(true);
  });

  it("never leaves the cache in plaintext next to the ciphertext", async () => {
    const layout = makeLayout();
    fs.writeFileSync(
      path.join(layout.credentials, "msal_token_cache.json"),
      cacheJson("m@outlook.com"),
    );
    await authState(layout, ACCT);
    const names = fs.readdirSync(layout.credentials);
    expect(names).toContain("msal_token_cache.enc");
    expect(names).not.toContain("msal_token_cache.json");
  });
});
