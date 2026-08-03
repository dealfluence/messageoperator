import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { Broker, type FolderOps, sendOutcomeLines } from "../src/broker.js";
import {
  applyFolderChange,
  type GmailClientLike,
  uploadDraft as gmailUploadDraft,
  deleteDraft as gmailDeleteDraft,
} from "../src/gmail.js";
import { Rejection } from "../src/intents.js";
import { sha12 } from "../src/layout.js";
import {
  moveMessage,
  type RequestFn,
  uploadDraft as graphUploadDraft,
  deleteDraft as graphDeleteDraft,
} from "../src/msgraph.js";
import { makeConfig, makeLayout, sampleEml, tmpHome } from "./helpers.js";

const GMAIL_ACCT = { provider: "gmail" as const, address: "a@gmail.com" };
const MS_ACCT = {
  provider: "microsoft" as const,
  address: "m@outlook.com",
  client_id: "cid",
};
const MSG_ID = "<archiveme@x>";

/**
 * Purpose-built fake IMAP client: folders hold uid -> Message-ID maps, every
 * method call is recorded so tests can assert what was (and was NOT) called.
 */
class FakeFolderImap implements GmailClientLike {
  calls: string[] = [];
  current = "";
  constructor(public folders: Record<string, Record<number, string>>) {}

  async noop(): Promise<unknown> {
    this.calls.push("noop");
    return undefined;
  }
  async status(): Promise<{ uidNext?: number; uidValidity?: number | bigint }> {
    this.calls.push("status");
    return { uidNext: 1, uidValidity: 1 };
  }
  async mailboxOpen(
    name: string,
    opts: { readOnly: boolean },
  ): Promise<{ uidValidity: number | bigint }> {
    this.calls.push(`open:${name}:${opts.readOnly ? "ro" : "rw"}`);
    this.current = name;
    return { uidValidity: 1 };
  }
  async search(query: any, _opts: { uid: boolean }): Promise<number[] | false> {
    this.calls.push(`search:${this.current}`);
    const mid = query?.header?.["message-id"];
    const found = Object.entries(this.folders[this.current] ?? {})
      .filter(([, m]) => m === mid)
      .map(([u]) => Number(u));
    return found.length ? found : false;
  }
  async *fetch(): AsyncIterable<{ uid: number; source?: Buffer }> {
    this.calls.push("fetch");
  }
  async list(): Promise<Array<{ path: string; specialUse?: string }>> {
    this.calls.push("list");
    return [
      { path: "INBOX" },
      { path: "[Gmail]/All Mail", specialUse: "\\All" },
      { path: "[Gmail]/Trash", specialUse: "\\Trash" },
    ];
  }
  async messageMove(
    range: number[] | string,
    destination: string,
  ): Promise<unknown> {
    this.calls.push(`move:${this.current}->${destination}`);
    return undefined;
  }
  async messageCopy(
    range: number[] | string,
    destination: string,
  ): Promise<unknown> {
    this.calls.push(`copy:${this.current}->${destination}`);
    return undefined;
  }
  async append(
    mailbox: string,
    _content: Buffer | string,
    flags?: string[],
  ): Promise<{ uid?: number } | false> {
    this.calls.push(`append:${mailbox}:${(flags ?? []).join(",")}`);
    const folder = (this.folders[mailbox] ??= {});
    const uid = Object.keys(folder).length + 1;
    return { uid };
  }
  async logout(): Promise<void> {
    this.calls.push("logout");
  }
  close(): void {
    this.calls.push("close");
  }
}

function assertNeverDestructive(calls: string[]): void {
  // the whole feature contract: no deletion, no trash, no expunge, no flags
  expect(
    calls.filter((c) => /delete|trash|expunge|flag|store/i.test(c)),
  ).toEqual([]);
  expect(calls.filter((c) => /->\[Gmail\]\/Trash/.test(c))).toEqual([]);
}

function gmailOpts(client: FakeFolderImap) {
  return {
    clientFactory: async () => client,
    getPassword: () => "pw",
  };
}

describe("gmail applyFolderChange", () => {
  const ARCHIVE = { messageId: MSG_ID, removeLabels: ["INBOX"], addLabels: [] };
  const UNARCHIVE = {
    messageId: MSG_ID,
    removeLabels: [],
    addLabels: ["INBOX"],
  };

  it("archive moves an inbox message to All Mail (label INBOX removed)", async () => {
    const layout = makeLayout();
    const client = new FakeFolderImap({
      INBOX: { 7: MSG_ID },
      "[Gmail]/All Mail": {},
    });
    const result = await applyFolderChange(
      layout,
      makeConfig(),
      GMAIL_ACCT,
      ARCHIVE,
      gmailOpts(client),
    );
    expect(result).toBe("applied");
    expect(client.calls).toContain("move:INBOX->[Gmail]/All Mail");
    assertNeverDestructive(client.calls);
  });

  it("archive of an already-archived message is a clean no-op", async () => {
    const layout = makeLayout();
    const client = new FakeFolderImap({
      INBOX: {},
      "[Gmail]/All Mail": { 3: MSG_ID },
    });
    const result = await applyFolderChange(
      layout,
      makeConfig(),
      GMAIL_ACCT,
      ARCHIVE,
      gmailOpts(client),
    );
    expect(result).toBe("noop");
    expect(client.calls.filter((c) => c.startsWith("move:"))).toEqual([]);
    expect(client.calls.filter((c) => c.startsWith("copy:"))).toEqual([]);
    assertNeverDestructive(client.calls);
  });

  it("archive of a message that exists nowhere rejects safely", async () => {
    const layout = makeLayout();
    const client = new FakeFolderImap({ INBOX: {}, "[Gmail]/All Mail": {} });
    await expect(
      applyFolderChange(
        layout,
        makeConfig(),
        GMAIL_ACCT,
        ARCHIVE,
        gmailOpts(client),
      ),
    ).rejects.toThrow(Rejection);
    assertNeverDestructive(client.calls);
  });

  it("unarchive copies from All Mail back to INBOX (label INBOX added)", async () => {
    const layout = makeLayout();
    const client = new FakeFolderImap({
      INBOX: {},
      "[Gmail]/All Mail": { 3: MSG_ID },
    });
    const result = await applyFolderChange(
      layout,
      makeConfig(),
      GMAIL_ACCT,
      UNARCHIVE,
      gmailOpts(client),
    );
    expect(result).toBe("applied");
    expect(client.calls).toContain("copy:[Gmail]/All Mail->INBOX");
    assertNeverDestructive(client.calls);
  });

  it("unarchive of a message already in INBOX is a no-op", async () => {
    const layout = makeLayout();
    const client = new FakeFolderImap({
      INBOX: { 4: MSG_ID },
      "[Gmail]/All Mail": { 3: MSG_ID },
    });
    const result = await applyFolderChange(
      layout,
      makeConfig(),
      GMAIL_ACCT,
      UNARCHIVE,
      gmailOpts(client),
    );
    expect(result).toBe("noop");
    expect(client.calls.filter((c) => c.startsWith("copy:"))).toEqual([]);
  });

  it("fails safe with no app password: rejects, zero provider calls", async () => {
    const layout = makeLayout();
    const client = new FakeFolderImap({ INBOX: { 7: MSG_ID } });
    await expect(
      applyFolderChange(layout, makeConfig(), GMAIL_ACCT, ARCHIVE, {
        clientFactory: async () => client,
        getPassword: () => null,
      }),
    ).rejects.toThrow(Rejection);
    expect(client.calls).toEqual([]);
  });
});

describe("gmail provider drafts", () => {
  it("uploadDraft APPENDs to the \\Drafts special-use mailbox with \\Draft", async () => {
    const layout = makeLayout();
    const client = new FakeFolderImap({
      INBOX: {},
      "[Gmail]/All Mail": {},
    });
    // teach list() a Drafts special-use for this test
    client.list = async () => [
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "[Gmail]/Drafts", specialUse: "\\Drafts" },
      { path: "[Gmail]/Trash", specialUse: "\\Trash" },
    ];
    const res = await gmailUploadDraft(
      layout,
      makeConfig(),
      GMAIL_ACCT,
      Buffer.from("From: a@gmail.com\r\nSubject: hi\r\n\r\nbody\r\n"),
      gmailOpts(client),
    );
    expect(res.mailbox).toBe("[Gmail]/Drafts");
    expect(
      client.calls.some((c) => c.startsWith("append:[Gmail]/Drafts:\\Draft")),
    ).toBe(true);
    assertNeverDestructive(client.calls);
  });

  it("deleteDraft moves a matching draft from Drafts to Trash (reversible)", async () => {
    const layout = makeLayout();
    const client = new FakeFolderImap({
      "[Gmail]/Drafts": { 5: MSG_ID },
      "[Gmail]/Trash": {},
    });
    client.list = async () => [
      { path: "[Gmail]/Drafts", specialUse: "\\Drafts" },
      { path: "[Gmail]/Trash", specialUse: "\\Trash" },
    ];
    const result = await gmailDeleteDraft(
      layout,
      makeConfig(),
      GMAIL_ACCT,
      MSG_ID,
      gmailOpts(client),
    );
    expect(result).toBe("applied");
    expect(client.calls).toContain("move:[Gmail]/Drafts->[Gmail]/Trash");
    // the whole point: it MOVES, never STORE \Deleted / expunge
    expect(
      client.calls.filter((c) => /delete|expunge|flag|store/i.test(c)),
    ).toEqual([]);
  });

  it("deleteDraft is a clean no-op when no such draft exists", async () => {
    const layout = makeLayout();
    const client = new FakeFolderImap({ "[Gmail]/Drafts": {} });
    client.list = async () => [
      { path: "[Gmail]/Drafts", specialUse: "\\Drafts" },
      { path: "[Gmail]/Trash", specialUse: "\\Trash" },
    ];
    const result = await gmailDeleteDraft(
      layout,
      makeConfig(),
      GMAIL_ACCT,
      "<not-here@x>",
      gmailOpts(client),
    );
    expect(result).toBe("noop");
    expect(client.calls.filter((c) => c.startsWith("move:"))).toEqual([]);
  });

  it("uploadDraft fails safe with no app password: rejects, zero calls", async () => {
    const layout = makeLayout();
    const client = new FakeFolderImap({ "[Gmail]/Drafts": {} });
    await expect(
      gmailUploadDraft(layout, makeConfig(), GMAIL_ACCT, Buffer.from("x"), {
        clientFactory: async () => client,
        getPassword: () => null,
      }),
    ).rejects.toThrow(Rejection);
    expect(client.calls).toEqual([]);
  });
});

/** Fake Graph transport: routes by URL, records every request. */
function fakeGraph(state: {
  messageParent: string | null; // null = message not found
  archiveId?: string;
  inboxId?: string;
}) {
  const requests: string[] = [];
  const requestFn: RequestFn = async (method, url, _token, _opts) => {
    requests.push(`${method} ${url}`);
    if (method === "GET" && url.includes("/me/messages?")) {
      const value =
        state.messageParent === null
          ? []
          : [{ id: "msg-1", parentFolderId: state.messageParent }];
      return { status: 200, body: Buffer.from(JSON.stringify({ value })) };
    }
    if (method === "GET" && url.includes("/me/mailFolders/archive")) {
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({ id: state.archiveId ?? "arch-id" })),
      };
    }
    if (method === "GET" && url.includes("/me/mailFolders/inbox")) {
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({ id: state.inboxId ?? "inbox-id" })),
      };
    }
    if (method === "POST" && url.includes("/move")) {
      return {
        status: 201,
        body: Buffer.from(JSON.stringify({ id: "msg-1-moved" })),
      };
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  return { requests, requestFn };
}

describe("graph moveMessage", () => {
  it("archive moves the message to the archive well-known folder", async () => {
    const layout = makeLayout();
    const { requests, requestFn } = fakeGraph({ messageParent: "inbox-id" });
    const result = await moveMessage(
      layout,
      MS_ACCT,
      { internetMessageId: MSG_ID, target: "archive" },
      { requestFn, getToken: async () => "tok" },
    );
    expect(result).toBe("applied");
    expect(
      requests.some(
        (r) => r.startsWith("POST") && r.includes("/messages/msg-1/move"),
      ),
    ).toBe(true);
    expect(
      requests.filter((r) => /DELETE|deleteditems|permanentDelete/i.test(r)),
    ).toEqual([]);
  });

  it("is idempotent when the message already sits in the target folder", async () => {
    const layout = makeLayout();
    const { requests, requestFn } = fakeGraph({
      messageParent: "arch-id",
      archiveId: "arch-id",
    });
    const result = await moveMessage(
      layout,
      MS_ACCT,
      { internetMessageId: MSG_ID, target: "archive" },
      { requestFn, getToken: async () => "tok" },
    );
    expect(result).toBe("noop");
    expect(requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });

  it("rejects when the message cannot be found", async () => {
    const layout = makeLayout();
    const { requestFn } = fakeGraph({ messageParent: null });
    await expect(
      moveMessage(
        layout,
        MS_ACCT,
        { internetMessageId: MSG_ID, target: "archive" },
        { requestFn, getToken: async () => "tok" },
      ),
    ).rejects.toThrow(Rejection);
  });

  it("fails safe when unauthenticated: rejects, zero requests", async () => {
    const layout = makeLayout();
    const { requests, requestFn } = fakeGraph({ messageParent: "inbox-id" });
    await expect(
      moveMessage(
        layout,
        MS_ACCT,
        { internetMessageId: MSG_ID, target: "archive" },
        { requestFn, getToken: async () => null },
      ),
    ).rejects.toThrow(Rejection);
    expect(requests).toEqual([]);
  });
});

/** Fake Graph transport for drafts: create + drafts-scoped find + move. */
function fakeGraphDrafts(state: { draftFound: boolean }) {
  const requests: string[] = [];
  const requestFn: RequestFn = async (method, url, _token, _opts) => {
    requests.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/me/messages")) {
      return {
        status: 201,
        body: Buffer.from(
          JSON.stringify({ id: "draft-1", internetMessageId: MSG_ID }),
        ),
      };
    }
    if (method === "GET" && url.includes("/me/mailFolders/drafts/messages")) {
      const value = state.draftFound ? [{ id: "draft-1" }] : [];
      return { status: 200, body: Buffer.from(JSON.stringify({ value })) };
    }
    if (method === "POST" && url.includes("/move")) {
      return {
        status: 201,
        body: Buffer.from(JSON.stringify({ id: "draft-1-moved" })),
      };
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  return { requests, requestFn };
}

describe("graph provider drafts", () => {
  it("uploadDraft POSTs MIME to /me/messages and returns the ids", async () => {
    const layout = makeLayout();
    const { requests, requestFn } = fakeGraphDrafts({ draftFound: true });
    const res = await graphUploadDraft(layout, MS_ACCT, Buffer.from("mime"), {
      requestFn,
      getToken: async () => "tok",
    });
    expect(res.internetMessageId).toBe(MSG_ID);
    expect(
      requests.some(
        (r) => r === "POST https://graph.microsoft.com/v1.0/me/messages",
      ),
    ).toBe(true);
  });

  it("deleteDraft moves a Drafts message to deleteditems (reversible)", async () => {
    const layout = makeLayout();
    const { requests, requestFn } = fakeGraphDrafts({ draftFound: true });
    const result = await graphDeleteDraft(layout, MS_ACCT, MSG_ID, {
      requestFn,
      getToken: async () => "tok",
    });
    expect(result).toBe("applied");
    // scoped to the Drafts folder, and a /move (never DELETE/permanentDelete)
    expect(
      requests.some((r) => r.includes("/me/mailFolders/drafts/messages")),
    ).toBe(true);
    expect(
      requests.some((r) => r.startsWith("POST") && r.includes("/move")),
    ).toBe(true);
    expect(requests.filter((r) => /DELETE |permanentDelete/i.test(r))).toEqual(
      [],
    );
  });

  it("deleteDraft is a no-op when the draft is not found", async () => {
    const layout = makeLayout();
    const { requests, requestFn } = fakeGraphDrafts({ draftFound: false });
    const result = await graphDeleteDraft(layout, MS_ACCT, MSG_ID, {
      requestFn,
      getToken: async () => "tok",
    });
    expect(result).toBe("noop");
    expect(requests.filter((r) => r.includes("/move"))).toEqual([]);
  });

  it("both fail safe when unauthenticated: reject, zero requests", async () => {
    const layout = makeLayout();
    const up = fakeGraphDrafts({ draftFound: true });
    await expect(
      graphUploadDraft(layout, MS_ACCT, Buffer.from("mime"), {
        requestFn: up.requestFn,
        getToken: async () => null,
      }),
    ).rejects.toThrow(Rejection);
    expect(up.requests).toEqual([]);

    const del = fakeGraphDrafts({ draftFound: true });
    await expect(
      graphDeleteDraft(layout, MS_ACCT, MSG_ID, {
        requestFn: del.requestFn,
        getToken: async () => null,
      }),
    ).rejects.toThrow(Rejection);
    expect(del.requests).toEqual([]);
  });
});

// ---- broker-level processing ---------------------------------------

function makeArchiveBroker(
  opts: { dryRun?: boolean; folderOps?: FolderOps; home?: string } = {},
) {
  // `home` reattaches to an existing room, which is how a dry-run session and
  // a later real session are modelled against the same local state
  const broker = new Broker(opts.home ?? tmpHome(), {
    mode: "boundary",
    gmailSync: async () => {},
    graphSync: async () => {},
    detectProvider: async () => null,
    folderOps: opts.folderOps,
  });
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
  return broker;
}

/** Seed a synced inbox message (file + index row); returns its request fields. */
function seedInbox(broker: Broker, subject: string, messageId: string) {
  const raw = sampleEml({ subject, messageId });
  const sha = sha12(raw);
  const filename = `1700000000.${sha}.eml`;
  const dir = path.join(
    broker.layout.accounts,
    "a@gmail.com",
    "mail",
    "INBOX",
    "cur",
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), raw);
  fs.writeFileSync(
    path.join(dir, filename) + ".meta",
    JSON.stringify({ body: subject }),
  );
  broker.index.insertMessage({
    sha,
    account: "a@gmail.com",
    folder: "INBOX",
    filename,
    path: `accounts/a@gmail.com/mail/INBOX/cur/${filename}`,
    date: "Mon, 07 Jul 2026 10:00:00 +0000",
    epoch: 1700000000,
    from: "x@example.com",
    to: "a@gmail.com",
    subject,
    body: subject,
  });
  return {
    sha,
    filename,
    relPath: `accounts/a@gmail.com/mail/INBOX/cur/${filename}`,
    messageId,
  };
}

function queueRequest(broker: Broker, request: object): void {
  fs.appendFileSync(
    path.join(broker.layout.room, ".folder-request.jsonl"),
    JSON.stringify(request) + "\n",
  );
}

describe("broker folder-change processing", () => {
  it("executes an archive live, moves the local file, and reindexes", async () => {
    const applied: string[] = [];
    const broker = makeArchiveBroker({
      dryRun: false,
      folderOps: {
        gmail: async (acct, change) => {
          applied.push(`${acct.address}:${change.op}:${change.messageId}`);
          return "applied";
        },
        microsoft: async () => "applied",
      },
    });
    await broker.runCycle({ syncNetwork: false }); // baseline manifest
    const seeded = seedInbox(broker, "archive me", MSG_ID);
    await broker.runCycle({ syncNetwork: false }); // observe the seeded file
    queueRequest(broker, {
      op: "archive",
      account: "a@gmail.com",
      path: seeded.relPath,
      sha: seeded.sha,
      message_id: MSG_ID,
    });

    const offset = broker.ledger.tailOffset();
    const outcomes = await broker.pushReport();
    expect(applied).toEqual([`a@gmail.com:archive:${MSG_ID}`]);
    expect(outcomes.some((l) => l.startsWith("ARCHIVED"))).toBe(true);

    // local room reflects the change
    const archived = path.join(
      broker.layout.accounts,
      "a@gmail.com",
      "mail",
      "Archive",
      "cur",
      seeded.filename,
    );
    expect(fs.existsSync(archived)).toBe(true);
    expect(fs.existsSync(path.join(broker.layout.room, seeded.relPath))).toBe(
      false,
    );
    const row = broker.index.allMessages().find((r) => r.sha === seeded.sha);
    expect(row?.folder).toBe("Archive");
    expect(row?.path).toContain("/Archive/");
    // the archive's own file moves are explained to the audit, not flagged
    expect(
      broker.ledger.readSince(offset).some((r) => r.op === "state_diff"),
    ).toBe(false);
    const executed = broker.ledger
      .readAll()
      .find((r) => r.op === "folder_change_executed");
    expect((executed?.details as any).op).toBe("archive");
    broker.close();
  });

  it("simulates under dry_run: no provider call, SIMULATED outcome", async () => {
    let providerCalled = 0;
    const broker = makeArchiveBroker({
      dryRun: true,
      folderOps: {
        gmail: async () => {
          providerCalled += 1;
          return "applied";
        },
        microsoft: async () => {
          providerCalled += 1;
          return "applied";
        },
      },
    });
    await broker.runCycle({ syncNetwork: false });
    const seeded = seedInbox(broker, "dry run archive", MSG_ID);
    await broker.runCycle({ syncNetwork: false });
    queueRequest(broker, {
      op: "archive",
      account: "a@gmail.com",
      path: seeded.relPath,
      sha: seeded.sha,
      message_id: MSG_ID,
    });

    const outcomes = await broker.pushReport();
    expect(providerCalled).toBe(0);
    expect(outcomes.some((l) => l.includes("SIMULATED ARCHIVE"))).toBe(true);
    expect(
      broker.ledger.readAll().some((r) => r.op === "folder_change_simulated"),
    ).toBe(true);

    // A simulated change must leave the room byte-identical to the mailbox.
    // This used to move the file and re-home the index "as a preview", which
    // made mail.py's no-op guard short-circuit every LATER real archive of the
    // same message — silently, permanently, and unrecoverably by turning dry
    // run off, because that guard reads local state and ignores dry_run.
    const inboxPath = path.join(broker.layout.room, seeded.relPath);
    expect(fs.existsSync(inboxPath)).toBe(true);
    expect(fs.existsSync(inboxPath + ".meta")).toBe(true);
    // the maildir tree is scaffolded up front, so assert it stayed EMPTY
    // rather than absent
    const archiveDir = path.join(
      broker.layout.accounts,
      "a@gmail.com",
      "mail",
      "Archive",
      "cur",
    );
    const archived = fs.existsSync(archiveDir)
      ? fs.readdirSync(archiveDir)
      : [];
    expect(archived).toEqual([]);
    expect(broker.index.getBySha(seeded.sha)?.folder).toBe("INBOX");
    broker.close();
  });

  it("moves the local file when the provider reports a different folder", async () => {
    // Drift: the user archives a message in Gmail's web UI / Outlook / a phone.
    // Sync skips messages it has already indexed, so nothing used to notice, and
    // the room showed it in the inbox forever. reconcileFolder re-homes the row;
    // this asserts the broker then moves the FILE and explains the move.
    const broker = makeArchiveBroker({ dryRun: true });
    await broker.runCycle({ syncNetwork: false });
    const seeded = seedInbox(broker, "moved outside mailroom", MSG_ID);
    await broker.runCycle({ syncNetwork: false });

    // stand in for the sync pass: the provider now says Archive
    broker.index.updateMessageLocation(seeded.sha, "INBOX", seeded.relPath);
    expect(
      broker.index.reconcileFolder("a@gmail.com", "P-DRIFT", "Archive"),
    ).toBeNull(); // no such provider id yet
    broker.index.insertMessage({
      sha: "driftsha0001",
      account: "a@gmail.com",
      folder: "INBOX",
      filename: path.basename(seeded.relPath),
      path: seeded.relPath,
      date: "Mon, 07 Jul 2026 10:00:00 +0000",
      epoch: 1700000001,
      from: "x@example.com",
      to: "a@gmail.com",
      subject: "moved outside mailroom",
      body: "b",
      gmailId: "P-DRIFT",
    });
    expect(
      broker.index.reconcileFolder("a@gmail.com", "P-DRIFT", "Archive"),
    ).toMatchObject({ from: "INBOX", to: "Archive" });

    const offset = broker.ledger.tailOffset();
    await broker.runCycle({ syncNetwork: false });

    // the file followed the row into Archive/
    const archived = path.join(
      broker.layout.accounts,
      "a@gmail.com",
      "mail",
      "Archive",
      "cur",
      path.basename(seeded.relPath),
    );
    expect(fs.existsSync(archived)).toBe(true);
    expect(fs.existsSync(path.join(broker.layout.room, seeded.relPath))).toBe(
      false,
    );
    const since = broker.ledger.readSince(offset);
    expect(since.some((r) => r.op === "folder_drift_corrected")).toBe(true);
    // the move must be explained, or the audit reports it as an unknown change
    expect(since.some((r) => r.op === "state_diff")).toBe(false);
    broker.close();
  });

  it("a real archive still works after the same message was archived under dry run", async () => {
    // The field failure end to end: dry-run archive, then turn dry run off and
    // archive again. Before the fix the second attempt no-op'd because the room
    // already said "Archive", so the provider was never called and the message
    // stayed in the user's inbox forever while the tool reported success.
    let providerCalled = 0;
    const folderOps = {
      gmail: async () => {
        providerCalled += 1;
        return "applied" as const;
      },
      microsoft: async () => "applied" as const,
    };

    const dry = makeArchiveBroker({ dryRun: true, folderOps });
    await dry.runCycle({ syncNetwork: false });
    const seeded = seedInbox(dry, "dry then real", MSG_ID);
    await dry.runCycle({ syncNetwork: false });
    queueRequest(dry, {
      op: "archive",
      account: "a@gmail.com",
      path: seeded.relPath,
      sha: seeded.sha,
      message_id: MSG_ID,
    });
    await dry.pushReport();
    expect(providerCalled).toBe(0);
    // the room is unchanged, so `mail archive` will still see it in INBOX and
    // queue a real request rather than reporting "already archived (no-op)"
    expect(dry.index.getBySha(seeded.sha)?.folder).toBe("INBOX");
    dry.close();

    // same room, dry run now off
    const real = makeArchiveBroker({
      dryRun: false,
      folderOps,
      home: dry.layout.home,
    });
    queueRequest(real, {
      op: "archive",
      account: "a@gmail.com",
      path: seeded.relPath,
      sha: seeded.sha,
      message_id: MSG_ID,
    });
    const outcomes = await real.pushReport();
    expect(providerCalled).toBe(1); // the provider is actually called this time
    expect(outcomes.some((l) => l.includes("ARCHIVED"))).toBe(true);
    expect(real.index.getBySha(seeded.sha)?.folder).toBe("Archive");
    real.close();
  });

  it("rejects safely when the adapter reports missing auth; nothing moves", async () => {
    const broker = makeArchiveBroker({
      dryRun: false,
      folderOps: {
        gmail: async () => {
          throw new Rejection(
            "needs_auth",
            "gmail app password missing; run `mail login a@gmail.com`",
          );
        },
        microsoft: async () => "applied",
      },
    });
    await broker.runCycle({ syncNetwork: false });
    const seeded = seedInbox(broker, "auth fail", MSG_ID);
    await broker.runCycle({ syncNetwork: false });
    queueRequest(broker, {
      op: "archive",
      account: "a@gmail.com",
      path: seeded.relPath,
      sha: seeded.sha,
      message_id: MSG_ID,
    });

    const outcomes = await broker.pushReport();
    expect(
      outcomes.some((l) => l.includes("REJECTED") && l.includes("needs_auth")),
    ).toBe(true);
    expect(fs.existsSync(path.join(broker.layout.room, seeded.relPath))).toBe(
      true,
    ); // unmoved
    const row = broker.index.allMessages().find((r) => r.sha === seeded.sha);
    expect(row?.folder).toBe("INBOX");
    broker.close();
  });

  it("processes a batch independently: one bad request does not sink the rest", async () => {
    const applied: string[] = [];
    const broker = makeArchiveBroker({
      dryRun: false,
      folderOps: {
        gmail: async (_acct, change) => {
          applied.push(change.messageId);
          return "applied";
        },
        microsoft: async () => "applied",
      },
    });
    await broker.runCycle({ syncNetwork: false });
    const good = seedInbox(broker, "good", "<good@x>");
    await broker.runCycle({ syncNetwork: false });
    queueRequest(broker, {
      op: "archive",
      account: "nobody@nowhere.example",
      path: "x",
      sha: "0".repeat(12),
      message_id: "<bad@x>",
    });
    queueRequest(broker, {
      op: "archive",
      account: "a@gmail.com",
      path: good.relPath,
      sha: good.sha,
      message_id: "<good@x>",
    });

    const outcomes = await broker.pushReport();
    expect(applied).toEqual(["<good@x>"]);
    expect(
      outcomes.some(
        (l) => l.includes("REJECTED") && l.includes("unknown_account"),
      ),
    ).toBe(true);
    expect(outcomes.some((l) => l.startsWith("ARCHIVED"))).toBe(true);
    broker.close();
  });

  it("unarchive preset restores the local file to INBOX", async () => {
    const broker = makeArchiveBroker({
      dryRun: false,
      folderOps: {
        gmail: async () => "applied",
        microsoft: async () => "applied",
      },
    });
    await broker.runCycle({ syncNetwork: false });
    const seeded = seedInbox(broker, "roundtrip", MSG_ID);
    await broker.runCycle({ syncNetwork: false });
    queueRequest(broker, {
      op: "archive",
      account: "a@gmail.com",
      path: seeded.relPath,
      sha: seeded.sha,
      message_id: MSG_ID,
    });
    await broker.push();
    const archivedRel = `accounts/a@gmail.com/mail/Archive/cur/${seeded.filename}`;
    queueRequest(broker, {
      op: "unarchive",
      account: "a@gmail.com",
      path: archivedRel,
      sha: seeded.sha,
      message_id: MSG_ID,
    });
    const outcomes = await broker.pushReport();
    expect(outcomes.some((l) => l.startsWith("UNARCHIVED"))).toBe(true);
    expect(fs.existsSync(path.join(broker.layout.room, seeded.relPath))).toBe(
      true,
    );
    expect(
      broker.index.allMessages().find((r) => r.sha === seeded.sha)?.folder,
    ).toBe("INBOX");
    broker.close();
  });
});

describe("sendOutcomeLines folder-change rendering", () => {
  it("renders executed, simulated, and rejected folder changes", () => {
    const lines = sendOutcomeLines([
      {
        ts: "",
        actor: "broker",
        op: "folder_change_executed",
        sha: "abc",
        details: { op: "archive", path: "p", result: "applied" },
      },
      {
        ts: "",
        actor: "broker",
        op: "folder_change_simulated",
        sha: "def",
        details: { op: "unarchive", path: "q" },
      },
      {
        ts: "",
        actor: "broker",
        op: "folder_change_rejected",
        sha: "ghi",
        details: {
          op: "archive",
          path: "r",
          reason: "needs_auth",
          detail: "run mail login",
        },
      },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("ARCHIVED");
    expect(lines[1]).toContain("SIMULATED UNARCHIVE");
    expect(lines[2]).toContain("ARCHIVE REJECTED (needs_auth)");
  });
});
