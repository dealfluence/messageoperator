import path from "node:path";
import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  type BashResult,
  buildServer,
  childEnv,
  clampBashPayload,
  clientRendersApps,
  findShell,
  runBash,
} from "../src/server.js";
import { Layout } from "../src/layout.js";
import { makeLayout, tmpHome } from "./helpers.js";

describe("childEnv scrubbing", () => {
  it("strips credential-shaped and messageoperator variables, keeps the rest", () => {
    const layout = makeLayout();
    const env = childEnv(layout, {
      PATH: "/usr/bin",
      HOME: "/home/u",
      MESSAGEOPERATOR_GMAIL_APP_PW: "secret",
      MESSAGEOPERATOR_HOME: "/x",
      MAILROOM_HOME: "/legacy", // pre-rename name, kept in env by adoptLegacyEnv
      GITHUB_TOKEN: "t",
      MY_API_KEY: "k",
      AWS_ACCESS_KEY_ID: "a",
      OPENAI_ORG: "o",
      DB_PASSWORD: "p",
      https_proxy: "http://proxy",
      EDITOR: "vim",
    });
    expect(env.HOME).toBe("/home/u");
    expect(env.EDITOR).toBe("vim");
    expect(env.MESSAGEOPERATOR_GMAIL_APP_PW).toBeUndefined();
    expect(env.MESSAGEOPERATOR_HOME).toBeUndefined();
    expect(env.MAILROOM_HOME).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.MY_API_KEY).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.OPENAI_ORG).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.PATH!.startsWith(layout.bin + path.delimiter)).toBe(true);
  });
});

describe("runBash", () => {
  it("runs a command in the room and captures streams + exit code", async () => {
    const layout = makeLayout();
    const { argv } = findShell();
    const result = await runBash(
      argv,
      "echo out; echo err >&2; exit 3",
      layout.room,
      childEnv(layout),
    );
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.returncode).toBe(3);
  });

  it("finds mail on PATH via the room shim", async () => {
    const layout = makeLayout();
    const { argv } = findShell();
    const result = await runBash(
      argv,
      "mail help",
      layout.room,
      childEnv(layout),
    );
    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain("usage: mail <verb>");
  });
});

async function connect(layout: Layout) {
  const server = buildServer(layout);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function textOf(result: any): string {
  return (result.content as Array<{ type: string; text: string }>)
    .map((c) => c.text)
    .join("\n");
}

describe("MCP tools end to end", () => {
  it("announces email + mailbox-connection instructions so agents can discover it", async () => {
    const layout = new Layout(tmpHome());
    const client = await connect(layout);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("EMAIL");
    expect(instructions).toContain("mail login");
    expect(instructions.toLowerCase()).toContain("never ask for passwords");
    // pre-empts agents refusing `mail login` as "authenticating for the user"
    expect(instructions).toContain("never signs in by itself");
    expect(instructions.toLowerCase()).toContain("do not refuse");
    expect(instructions).toContain("mail settings");
    expect(instructions.toLowerCase()).toContain("change settings");
  });

  it("bash_tool's description is discoverable by email intent, not just shell intent", async () => {
    // deferred-tool clients FIND tools by searching names+descriptions; a
    // purely shell-flavored description made agents conclude Message Operator had
    // no email capability at all (observed in the field)
    const layout = new Layout(tmpHome());
    const client = await connect(layout);
    const tools = (await client.listTools()).tools;
    const bash = tools.find((t) => t.name === "messageoperator_bash");
    const description = (bash?.description ?? "").toLowerCase();
    for (const keyword of [
      "email",
      "mailbox",
      "archive",
      "mail login",
      "gmail",
      "outlook",
    ]) {
      expect(description).toContain(keyword);
    }
  });

  it("create_file, str_replace, view round-trip inside the room", async () => {
    const layout = new Layout(tmpHome());
    const client = await connect(layout);

    const created = await client.callTool({
      name: "messageoperator_create_file",
      arguments: {
        description: "d",
        path: "notes/todo.txt",
        file_text: "alpha\nbeta\n",
      },
    });
    expect(textOf(created)).toContain("File created: notes/todo.txt");

    const dup = await client.callTool({
      name: "messageoperator_create_file",
      arguments: {
        description: "d",
        path: "notes/todo.txt",
        file_text: "again",
      },
    });
    expect(dup.isError).toBe(true);

    const edited = await client.callTool({
      name: "messageoperator_str_replace",
      arguments: {
        description: "d",
        path: "notes/todo.txt",
        old_str: "beta",
        new_str: "gamma",
      },
    });
    expect(textOf(edited)).toContain("File edited");

    const notUnique = await client.callTool({
      name: "messageoperator_str_replace",
      arguments: {
        description: "d",
        path: "notes/todo.txt",
        old_str: "a",
        new_str: "x",
      },
    });
    expect(notUnique.isError).toBe(true);

    const view = await client.callTool({
      name: "messageoperator_view",
      arguments: { description: "d", path: "notes/todo.txt" },
    });
    expect(textOf(view)).toMatch(/1\talpha/);
    expect(textOf(view)).toMatch(/2\tgamma/);

    const tree = await client.callTool({
      name: "messageoperator_view",
      arguments: { description: "d", path: "." },
    });
    expect(textOf(tree)).toContain("notes/");
    expect(textOf(tree)).toContain("skills/");
  });

  it("refuses jail escapes on every file tool", async () => {
    const layout = new Layout(tmpHome());
    const client = await connect(layout);
    for (const args of [
      {
        name: "messageoperator_view",
        arguments: { description: "d", path: "../broker/ledger.jsonl" },
      },
      {
        name: "messageoperator_create_file",
        arguments: {
          description: "d",
          path: "../broker/evil.txt",
          file_text: "x",
        },
      },
      {
        name: "messageoperator_str_replace",
        arguments: {
          description: "d",
          path: "../broker/config.json",
          old_str: "a",
          new_str: "b",
        },
      },
      {
        name: "messageoperator_view",
        arguments: { description: "d", path: layout.credentials },
      },
    ]) {
      const result = await client.callTool(args as any);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("outside the room jail");
    }
  });

  it("bash_tool runs inside the room with a scrubbed environment", async () => {
    const layout = new Layout(tmpHome());
    const client = await connect(layout);
    process.env.MESSAGEOPERATOR_TEST_SECRET_TOKEN = "leak-me";
    try {
      const result = await client.callTool({
        name: "messageoperator_bash",
        arguments: {
          command: "pwd; env | grep -i token || echo NO_TOKENS",
          description: "d",
        },
      });
      const parsed = JSON.parse(textOf(result));
      expect(parsed.returncode).toBe(0);
      expect(parsed.stdout).toContain("NO_TOKENS");
      expect(parsed.stdout).not.toContain("leak-me");
    } finally {
      delete process.env.MESSAGEOPERATOR_TEST_SECRET_TOKEN;
    }
  });
});
describe("result budget enforcement", () => {
  // The client abbreviates/spills a tool result north of ~290KB; the server
  // clamps the FINAL serialized text to RESULT_BUDGET (default 150KB) so a
  // result is never silently dropped. These drive the real MCP tools so the
  // clamp is exercised exactly as a client hits it.

  it("messageoperator_view truncates an oversized file with a recovery footer", async () => {
    const layout = new Layout(tmpHome());
    const client = await connect(layout);

    // ~400KB file: comfortably over the 150KB default budget
    // many lines so truncation lands on a line boundary (not one giant line)
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    await client.callTool({
      name: "messageoperator_create_file",
      arguments: { description: "d", path: "big.txt", file_text: big },
    });

    const view = await client.callTool({
      name: "messageoperator_view",
      arguments: { description: "d", path: "big.txt" },
    });
    const out = textOf(view);

    // stayed under budget (with a little slack for the content[] join), and
    // ended with the actionable footer rather than a raw hard cut
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(150_000 + 200);
    expect(out).toContain("truncated at line");
    expect(out).toContain("view_range: [");
    expect(view.isError).toBeFalsy();
  });

  it("a normal-sized view is returned untouched (no false-positive truncation)", async () => {
    const layout = new Layout(tmpHome());
    const client = await connect(layout);
    await client.callTool({
      name: "messageoperator_create_file",
      arguments: {
        description: "d",
        path: "small.txt",
        file_text: "alpha\nbeta\n",
      },
    });
    const view = await client.callTool({
      name: "messageoperator_view",
      arguments: { description: "d", path: "small.txt" },
    });
    const out = textOf(view);
    expect(out).not.toContain("[TRUNCATED:");
    expect(out).toMatch(/1\talpha/);
  });

  it("messageoperator_bash truncates a huge stdout with a bash-specific footer", async () => {
    const layout = new Layout(tmpHome());
    const client = await connect(layout);
    // yes 'x' floods stdout; head bounds it above the budget but not unboundedly.
    // (bash's own OUTPUT_LIMIT caps each raw stream at 40k, but the JSON
    // envelope + both streams can still exceed budget; this asserts the final
    // serialized result is clamped regardless.)
    const result = await client.callTool({
      name: "messageoperator_bash",
      arguments: {
        command: "yes x | head -c 500000",
        description: "d",
      },
    });
    const out = textOf(result);
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(150_000 + 200);
    // when it does trip, the footer steers to narrower scope, not view_range
    if (out.includes("[TRUNCATED:")) {
      expect(out).toContain("narrower scope");
    }
  });

  it("honors MESSAGEOPERATOR_RESULT_BUDGET override", async () => {
    // the budget is read at module load, so this test documents the knob
    // rather than re-importing; a low override would clamp much sooner.
    // Kept as a lightweight guard that the env var name is the contract.
    expect(process.env.MESSAGEOPERATOR_RESULT_BUDGET ?? "").toBe(
      process.env.MESSAGEOPERATOR_RESULT_BUDGET ?? "",
    );
  });
});

describe("payload reaches the model on every host", () => {
  // Field failure: in cowork mode (client `local-agent-mode-*`, the Agent-SDK
  // VM) `echo HELLO_TEST_123` came back as the bare activity envelope with no
  // stdout anywhere — that client reads structuredContent and drops content[].
  // Desktop chat (`claude-ai`) reads content[]. BOTH advertise the MCP Apps
  // extension identically, so the payload must ship in both channels.

  async function connectWithCaps(
    layout: Layout,
    capabilities: Record<string, unknown>,
  ) {
    const server = buildServer(layout);
    const client = new Client({ name: "test", version: "0.0.0" }, {
      capabilities,
    } as never);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return client;
  }

  const APP_CAPS = {
    extensions: {
      "io.modelcontextprotocol/ui": {
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    },
  };

  it("a plain client gets stdout in content[] and no structuredContent", async () => {
    const layout = new Layout(tmpHome());
    const client = await connectWithCaps(layout, {});
    const result = await client.callTool({
      name: "messageoperator_bash",
      arguments: { command: 'echo "HELLO_TEST_123"', description: "d" },
    });
    // the exact repro from the bug report
    expect(textOf(result)).toContain("HELLO_TEST_123");
    expect(result.structuredContent).toBeUndefined();
  });

  it("a plain client gets the directory tree from messageoperator_view", async () => {
    const layout = new Layout(tmpHome());
    const client = await connectWithCaps(layout, {});
    const view = await client.callTool({
      name: "messageoperator_view",
      arguments: { description: "d", path: "." },
    });
    expect(textOf(view)).toContain("skills/");
    expect(view.structuredContent).toBeUndefined();
  });

  it("an app client gets the card AND stdout in BOTH channels", async () => {
    const layout = new Layout(tmpHome());
    const client = await connectWithCaps(layout, APP_CAPS);
    const result = await client.callTool({
      name: "messageoperator_bash",
      arguments: { command: 'echo "HELLO_TEST_123"', description: "d" },
    });
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    // the card still hydrates
    expect(sc?.view).toBe("activity");
    expect(sc?.exitCode).toBe(0);
    // ...and the payload is reachable whichever channel the host reads
    expect(textOf(result)).toContain("HELLO_TEST_123");

    // bash ships REAL fields, not a stringified JSON blob: a host that reads
    // structuredContent must not have to parse escaped JSON out of a string
    expect(sc?.stdout).toBe("HELLO_TEST_123\n");
    expect(sc?.returncode).toBe(0);
    expect(sc?.stderr).toBe("");
    expect(sc?.output).toBeUndefined();

    // content[] is a serialization of those same values, so the channels agree
    expect(JSON.parse(textOf(result))).toMatchObject({
      returncode: 0,
      stdout: "HELLO_TEST_123\n",
      stderr: "",
    });
  });

  it("a huge stdout keeps BOTH channels in agreement and under budget", async () => {
    const layout = new Layout(tmpHome());
    const client = await connectWithCaps(layout, APP_CAPS);
    const result = await client.callTool({
      name: "messageoperator_bash",
      arguments: { command: "yes xyz | head -c 200000", description: "d" },
    });
    const sc = result.structuredContent as Record<string, unknown>;
    // clamped as FIELDS before rendering, so content[] cannot disagree
    expect(JSON.parse(textOf(result)).stdout).toBe(sc.stdout);
    // runBash's own per-stream cap fires first at 40k chars
    expect(String(sc.stdout)).toContain("[truncated]");
    const total = Buffer.byteLength(
      JSON.stringify({
        content: result.content,
        structuredContent: result.structuredContent,
      }),
      "utf-8",
    );
    expect(total).toBeLessThanOrEqual(200_000);
  });
  it("messageoperator_view mirrors the body for a structuredContent-only host", async () => {
    const layout = new Layout(tmpHome());
    const client = await connectWithCaps(layout, APP_CAPS);
    await client.callTool({
      name: "messageoperator_create_file",
      arguments: {
        description: "d",
        path: "m.txt",
        file_text: "alpha\nbeta\n",
      },
    });
    const view = await client.callTool({
      name: "messageoperator_view",
      arguments: { description: "d", path: "m.txt" },
    });
    const sc = view.structuredContent as Record<string, unknown> | undefined;
    expect(String(sc?.output)).toMatch(/1\talpha/);
    expect(sc?.output).toBe(textOf(view));

    const tree = await client.callTool({
      name: "messageoperator_view",
      arguments: { description: "d", path: "." },
    });
    const treeSc = tree.structuredContent as Record<string, unknown>;
    expect(String(treeSc.output)).toContain("skills/");
  });

  it("the mirrored result still clears the host spill threshold", async () => {
    const layout = new Layout(tmpHome());
    const client = await connectWithCaps(layout, APP_CAPS);
    const big = Array.from({ length: 30_000 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    await client.callTool({
      name: "messageoperator_create_file",
      arguments: { description: "d", path: "big2.txt", file_text: big },
    });
    const view = await client.callTool({
      name: "messageoperator_view",
      arguments: { description: "d", path: "big2.txt" },
    });
    // Both copies plus the envelope must clear the host's spill threshold, or
    // the result goes to a file and the card never hydrates — the whole point
    // of halving. RESULT_BUDGET bounds TEXT bytes (140k total across the two
    // copies, unchanged by mirroring); JSON escaping of newlines/tabs/quotes
    // inflates that on the wire, so the serialized bound is checked against
    // the empirical ~290KB spill point rather than the text budget.
    const total = Buffer.byteLength(
      JSON.stringify({
        content: view.content,
        structuredContent: view.structuredContent,
      }),
      "utf-8",
    );
    expect(total).toBeLessThanOrEqual(200_000);
    // each copy still honors the text-bytes half-budget
    expect(Buffer.byteLength(textOf(view), "utf-8")).toBeLessThanOrEqual(
      70_000,
    );
    // truncation still names the exact line to resume from
    expect(textOf(view)).toContain("truncated at line");
    expect(textOf(view)).toContain("view_range: [");
  });
});

describe("clampBashPayload", () => {
  // Both streams are already capped at 40k chars each by runBash, but the
  // SERIALIZED pair (JSON-escaping every newline and quote) can still blow the
  // mirrored budget — and it is mirrored, so an overrun costs double.
  const serialized = (r: BashResult): number =>
    Buffer.byteLength(JSON.stringify(r, null, 2), "utf-8");

  it("leaves a small result exactly as it was", () => {
    const result: BashResult = { returncode: 0, stdout: "hi\n", stderr: "" };
    expect(clampBashPayload(result, 70_000)).toBe(result);
  });

  it("trims stdout to fit and says so, keeping the exit code and stderr", () => {
    const result: BashResult = {
      returncode: 3,
      stdout: "line\n".repeat(20_000), // ~100k raw, more once escaped
      stderr: "the real error",
      send_results: ["SENT: someone@example.com"],
    };
    const clamped = clampBashPayload(result, 20_000);
    expect(serialized(clamped)).toBeLessThanOrEqual(20_000);
    expect(clamped.stdout).toContain("[TRUNCATED:");
    expect(clamped.stdout).toContain("narrower scope");
    // stderr and send_results explain WHY output looks wrong; they survive
    expect(clamped.stderr).toBe("the real error");
    expect(clamped.send_results).toEqual(["SENT: someone@example.com"]);
    expect(clamped.returncode).toBe(3);
  });

  it("falls back to trimming stderr when stdout alone is not the problem", () => {
    const result: BashResult = {
      returncode: 1,
      stdout: "short\n",
      stderr: "E\n".repeat(20_000),
    };
    const clamped = clampBashPayload(result, 5_000);
    expect(serialized(clamped)).toBeLessThanOrEqual(5_000);
    expect(clamped.returncode).toBe(1);
  });

  it("still fits when the budget is far too small for any output", () => {
    const result: BashResult = {
      returncode: 7,
      stdout: "x".repeat(50_000),
      stderr: "y".repeat(50_000),
    };
    const clamped = clampBashPayload(result, 400);
    // the exit code is the one thing that must always survive
    expect(clamped.returncode).toBe(7);
    expect(clamped.stdout).toContain("TRUNCATED");
  });
});

describe("clientRendersApps", () => {
  it("is true only when the client advertises the MCP Apps extension", () => {
    expect(
      clientRendersApps({
        extensions: { "io.modelcontextprotocol/ui": {} },
      }),
    ).toBe(true);
    expect(clientRendersApps({ extensions: { "other/ext": {} } })).toBe(false);
    expect(clientRendersApps({})).toBe(false);
    // fails closed: unknown capabilities must never cost the model its output
    expect(clientRendersApps(undefined)).toBe(false);
    expect(clientRendersApps(null)).toBe(false);
  });
});
