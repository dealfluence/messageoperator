/**
 * The room: an MCP stdio server exposing four VM tools jailed to room/.
 *
 * There is no background broker service and no login tool. The broker acts
 * at tool-call boundaries: reading tools (messageoperator_bash, messageoperator_view) pull the outside
 * world in before they run, and mutating tools (messageoperator_bash, messageoperator_create_file,
 * messageoperator_str_replace) push queued work out when they finish. Lazy setup rides the
 * same edges — the first pull bootstraps the room from the extension
 * settings and starts any needed sign-in flow in the background.
 */

import { spawn, spawnSync, exec, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getUiCapability,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { activityUri, registerActivityAppParts } from "./apps/activity.js";
import {
  buildActivityStructured,
  type ActivityStructured,
} from "./apps/outcomes.js";
import { progress } from "./apps/progress.js";
import type { Broker } from "./broker.js";
import { loadConfig } from "./config.js";
import type { LedgerRecord } from "./ledger.js";
import { Layout } from "./layout.js";
import { log } from "./log.js";

const OUTPUT_LIMIT = 40_000; // chars per stream for bash_tool
// Hard ceiling on the FINAL serialized tool result (content[].text), measured
// in bytes. Empirically the client abbreviates/spills a result somewhere north
// of ~290KB; 150KB is ~half that, leaving room for JSON escaping and the
// send_results array so a result never silently gets dropped or written to a
// sandbox file. Configurable for deployments that know their client tolerates
// more.
const RESULT_BUDGET = (() => {
  const raw = Number(process.env.MESSAGEOPERATOR_RESULT_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 150_000;
})();
const BASH_TIMEOUT = 60; // seconds
const PIPE_GRACE = 5; // seconds to wait for output pipes after the shell exits
const DRAIN_CAP = 1_000_000; // bytes buffered per stream before we stop keeping data

// Env var names / patterns stripped from messageoperator_bash children so casual shell
// work in the room does not see proxies or ambient credentials.
const STRIP_EXACT = new Set([
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "ftp_proxy",
]);
const STRIP_SUBSTRINGS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "api_key",
  "apikey",
  "private_key",
];
const STRIP_PREFIXES = [
  "aws_",
  "azure_",
  "google_",
  "gcloud_",
  "openai_",
  "anthropic_",
  "messageoperator_",
  "mailroom_", // pre-rename prefix; adoptLegacyEnv leaves the originals in place
];

function whichSync(name: string): string | null {
  const exts =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * Locate a POSIX shell for messageoperator_bash. macOS (the target) always has
 * /bin/bash; the Windows branches keep the dev machine workable.
 */
export function findShell(): { label: string; argv: string[] } {
  const override = process.env.MESSAGEOPERATOR_BASH;
  if (override && fs.existsSync(override)) {
    return { label: `bash (${override})`, argv: [override, "-c"] };
  }
  if (process.platform === "win32") {
    const candidates: string[] = [];
    for (const v of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
      const base = process.env[v];
      if (base) {
        candidates.push(path.join(base, "Git", "bin", "bash.exe"));
        candidates.push(path.join(base, "Git", "usr", "bin", "bash.exe"));
      }
    }
    for (const cand of candidates) {
      if (fs.existsSync(cand))
        return { label: `git-bash (${cand})`, argv: [cand, "-c"] };
    }
    const found = whichSync("bash");
    if (found && !found.toLowerCase().includes("system32")) {
      return { label: `bash (${found})`, argv: [found, "-c"] };
    }
    throw new Error(
      "no usable shell for messageoperator_bash: install Git for Windows (git-bash) or set MESSAGEOPERATOR_BASH",
    );
  }
  const found = whichSync("bash") || "/bin/sh";
  return { label: `bash (${found})`, argv: [found, "-c"] };
}

export function childEnv(
  layout: Layout,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (STRIP_EXACT.has(lower)) continue;
    if (STRIP_SUBSTRINGS.some((s) => lower.includes(s))) continue;
    if (STRIP_PREFIXES.some((p) => lower.startsWith(p))) continue;
    env[key] = value;
  }
  // room/bin first so `mail` (and its node shim) always resolves
  env.PATH = layout.bin + path.delimiter + (env.PATH ?? "");
  return env;
}

export function openLocalFile(filePath: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      const cleanPath = filePath.replace(/"/g, '\\"');
      exec(`start "" "${cleanPath}"`);
    } else {
      spawn("xdg-open", [filePath], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  } catch (err) {
    log.warn(`could not open file: ${err}`);
  }
}

function killTree(proc: ChildProcess): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
        timeout: 15_000,
      });
    } else if (proc.pid) {
      process.kill(-proc.pid, "SIGKILL"); // detached => own process group
    }
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function truncate(text: string): string {
  return text.length > OUTPUT_LIMIT
    ? text.slice(0, OUTPUT_LIMIT) + "\n[truncated]"
    : text;
}

export interface BashResult {
  returncode: number;
  stdout: string;
  stderr: string;
  send_results?: string[];
}

export function runBash(
  shellArgv: string[],
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<BashResult> {
  return new Promise((resolve) => {
    const [shellCmd, ...shellRest] = shellArgv;
    if (!shellCmd) {
      resolve({ returncode: -1, stdout: "", stderr: "no shell configured" });
      return;
    }
    const proc = spawn(shellCmd, [...shellRest, command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"], // never let a child read the MCP pipe
      detached: process.platform !== "win32",
    });

    const { stdout: outPipe, stderr: errPipe } = proc;
    if (!outPipe || !errPipe) {
      killTree(proc);
      resolve({
        returncode: -1,
        stdout: "",
        stderr: "failed to open shell output pipes",
      });
      return;
    }
    const bufs = { out: [] as Buffer[], err: [] as Buffer[] };
    const lens = { out: 0, err: 0 };
    const closed = { out: false, err: false };
    outPipe.on("data", (c: Buffer) => {
      if (lens.out < DRAIN_CAP) {
        bufs.out.push(c);
        lens.out += c.length;
      }
    });
    errPipe.on("data", (c: Buffer) => {
      if (lens.err < DRAIN_CAP) {
        bufs.err.push(c);
        lens.err += c.length;
      }
    });
    outPipe.on("close", () => (closed.out = true));
    errPipe.on("close", () => (closed.err = true));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc);
    }, BASH_TIMEOUT * 1000);

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        returncode: -1,
        stdout: "",
        stderr: `failed to start shell: ${err}`,
      });
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      // Wait for pipe EOF only briefly: a daemon-style grandchild can hold
      // the pipes open indefinitely and must not wedge the server.
      const started = Date.now();
      const poll = setInterval(() => {
        const lingering = !(closed.out && closed.err);
        if (lingering && Date.now() - started < PIPE_GRACE * 1000) return;
        clearInterval(poll);
        const stdout = truncate(Buffer.concat(bufs.out).toString("utf-8"));
        let stderrText = Buffer.concat(bufs.err).toString("utf-8");
        if (timedOut) {
          stderrText += `\n[command timed out after ${BASH_TIMEOUT}s; process tree killed]`;
        }
        if (lingering) {
          stderrText +=
            "\n[note: a background process is still holding the output pipe; " +
            "captured output may be incomplete]";
        }
        resolve({
          returncode: timedOut ? -1 : (code ?? -1),
          stdout,
          stderr: truncate(stderrText),
        });
      }, 50);
    });
  });
}

export function renderTree(root: string, maxDepth = 2): string {
  const lines = [path.basename(root) + "/"];
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      lines.push(`${prefix}[unreadable: ${err}]`);
      return;
    }
    entries.sort((a, b) => {
      const dirness = Number(!a.isDirectory()) - Number(!b.isDirectory());
      return (
        dirness || a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      );
    });
    entries.forEach((entry, i) => {
      const last = i === entries.length - 1;
      const connector = last ? "└── " : "├── ";
      const suffix = entry.isDirectory() ? "/" : "";
      lines.push(`${prefix}${connector}${entry.name}${suffix}`);
      if (entry.isDirectory() && depth < maxDepth) {
        walk(
          path.join(dir, entry.name),
          prefix + (last ? "    " : "│   "),
          depth + 1,
        );
      }
    });
  };
  walk(root, "", 1);
  return lines.join("\n");
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// Claude Desktop diverts tool results over ~150,000 characters to the
// sandbox filesystem, and then the activity app never hydrates (it receives
// a file pointer instead of structuredContent). App-rendering tools keep
// this much slack under RESULT_BUDGET for the JSON envelope plus the
// structuredContent payload.
const APP_RESULT_HEADROOM = 10_000;

/**
 * Per-copy budget when the payload is MIRRORED into structuredContent.
 *
 * Hosts disagree about which channel the model reads and their capabilities
 * cannot tell them apart (see okApp), so the payload ships twice and each
 * copy gets half the room. Halving here is what keeps the doubled result
 * under the host's spill threshold.
 */
const MIRROR_BUDGET = Math.floor((RESULT_BUDGET - APP_RESULT_HEADROOM) / 2);

/**
 * Chars for the view body. Sized so view's own line-boundary truncation (which
 * can name the exact line to resume from) fires BEFORE the blunt byte clamp in
 * enforceResultBudget, whose footer cannot. Bounded by the mirrored budget
 * since the body travels in both channels.
 */
const VIEW_LIMIT = Math.min(120_000, MIRROR_BUDGET - 2_000);

// Continuation hints per tool: what Claude should do to get the rest. All are
// stateless — the caller names the next slice; the server holds no cursor.
const RECOVERY_HINTS: Record<string, string> = {
  messageoperator_view:
    "re-run messageoperator_view with a view_range past this point (e.g. view_range: [<last line shown + 1>, -1])",
  messageoperator_bash:
    "re-run with narrower scope: a smaller --limit, `mail read <id> --part N` for a long message, " +
    "a head/grep filter, or messageoperator_view with a view_range on the underlying file",
};

/**
 * Clamp the FINAL result text to maxBytes so the client never abbreviates
 * or spills it to a sandbox file. Truncates on a byte boundary (re-decoding
 * drops any split multibyte tail) and appends a footer telling Claude the
 * output is incomplete and how to fetch the rest.
 */
function enforceResultBudget(
  text: string,
  toolName?: string,
  maxBytes: number = RESULT_BUDGET,
): string {
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= maxBytes) return text;
  const hint = toolName ? RECOVERY_HINTS[toolName] : undefined;
  const footer =
    `\n\n[TRUNCATED: result exceeded ${maxBytes} bytes and is NOT complete. ` +
    (hint
      ? `To see more, ${hint}.]`
      : "Re-run with narrower scope to see more.]");
  const footerBytes = Buffer.byteLength(footer, "utf-8");
  const keep = Math.max(0, maxBytes - footerBytes);
  const head = Buffer.from(text, "utf-8").subarray(0, keep).toString("utf-8"); // a split multibyte char at the cut is dropped by the decoder
  return head + footer;
}

function ok(text: string, toolName?: string): ToolResult {
  return {
    content: [{ type: "text", text: enforceResultBudget(text, toolName) }],
  };
}

/**
 * Does this client render MCP Apps? Only such clients are sent
 * structuredContent at all; plain MCP clients get content[] with the full
 * budget and no card.
 *
 * NOTE this does NOT tell you which channel the model reads — see okApp.
 *
 * Fails CLOSED: absent or unrecognized capabilities mean "no app". A missing
 * activity card is cosmetic; missing output makes every read tool useless.
 */
export function clientRendersApps(
  caps:
    | (ClientCapabilities & { extensions?: Record<string, unknown> })
    | null
    | undefined,
): boolean {
  return getUiCapability(caps) !== undefined;
}

/**
 * ok() for app-rendering tools.
 *
 * Hosts disagree about which channel the MODEL reads, so the payload travels
 * in BOTH and each copy gets MIRROR_BUDGET:
 *
 *   - Claude Desktop chat (client `claude-ai`) reads content[].
 *   - Cowork mode (client `local-agent-mode-*`, the Agent-SDK VM) and Claude
 *     Code read structuredContent and drop content[] ENTIRELY — the field is
 *     the compat mirror of structuredContent per spec, so this is legal.
 *
 * Both advertise the MCP Apps extension identically, so capability sniffing
 * cannot distinguish them (verified in the field: gating on the extension
 * still returned a bare activity envelope in cowork). Mirroring is therefore
 * the only host-agnostic option — hence `output`, which the activity card
 * ignores because renderCard only reads named card fields.
 *
 * `structured` is null for clients with no app support: they get content[]
 * only, at the full budget, since nothing shares the envelope.
 */
function okApp(
  text: string,
  toolName: string,
  structured: ActivityStructured | null,
  payload?: Record<string, unknown>,
): ToolResult {
  if (!structured) return ok(text, toolName);
  // clamped ONCE and reused, so both copies are byte-identical and the total
  // is provably 2*MIRROR_BUDGET + envelope <= RESULT_BUDGET
  const clamped = enforceResultBudget(text, toolName, MIRROR_BUDGET);
  return {
    content: [{ type: "text", text: clamped }],
    // With a payload, structuredContent carries the REAL fields and `text` is
    // their serialization, so the two channels are views of identical values
    // rather than a string plus a copy of that string — which is what made the
    // model read bash results through two layers of JSON escaping. Callers that
    // pass a payload must pre-clamp it (see clampBashPayload) so `text` fits
    // without enforceResultBudget having to cut, which would desync them.
    structuredContent: payload
      ? { ...structured, ...payload }
      : { ...structured, output: clamped },
  };
}

/**
 * Trim a bash result's streams until its serialized form fits maxBytes.
 *
 * Clamping the FIELDS (not the rendered string) is what lets content[] and
 * structuredContent be built from the same values. stdout goes first because
 * it is almost always the bulk; stderr and send_results are kept as long as
 * possible since they explain WHY output looks wrong. JSON escaping inflates
 * newlines and quotes unpredictably, so this shrinks and re-measures rather
 * than computing a byte offset.
 */
export function clampBashPayload(
  result: BashResult,
  maxBytes: number = MIRROR_BUDGET,
): BashResult {
  const size = (r: BashResult): number =>
    Buffer.byteLength(JSON.stringify(r, null, 2), "utf-8");
  if (size(result) <= maxBytes) return result;

  const footer =
    `\n[TRUNCATED: output exceeded the result budget and is NOT complete. ` +
    `To see more, ${RECOVERY_HINTS.messageoperator_bash}.]`;
  const cut = (text: string, keep: number): string =>
    Buffer.from(text, "utf-8")
      .subarray(0, Math.max(0, keep))
      .toString("utf-8") + footer;

  let keep = result.stdout.length;
  let clamped = result;
  for (let i = 0; i < 64 && keep > 0; i += 1) {
    keep = Math.floor(keep * 0.7);
    clamped = { ...result, stdout: cut(result.stdout, keep) };
    if (size(clamped) <= maxBytes) return clamped;
  }
  // stdout alone was not the problem: stderr (or send_results) is oversized too
  clamped = { ...result, stdout: footer.trimStart() };
  let errKeep = result.stderr.length;
  for (let i = 0; i < 64 && errKeep > 0; i += 1) {
    errKeep = Math.floor(errKeep * 0.7);
    clamped = { ...clamped, stderr: cut(result.stderr, errKeep) };
    if (size(clamped) <= maxBytes) return clamped;
  }
  // last resort: keep only the exit code and the truncation notice, so the
  // model is never handed a result that silently exceeded the budget
  return {
    returncode: result.returncode,
    stdout: footer.trimStart(),
    stderr: "",
    ...(result.send_results ? { send_results: result.send_results } : {}),
  };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/** Late-binding slot: the broker attaches after the MCP handshake is live. */
export interface BrokerHolder {
  broker: Broker | null;
}

/**
 * Build the MCP server. `holder.broker` (boundary mode, or null) is hooked
 * to the tool-call edges; its pull/push never throw, so broker trouble can
 * never break a tool call. The holder indirection lets serve() answer
 * `initialize` immediately and attach the broker afterwards.
 */
export function buildServer(
  layout?: Layout,
  holder: BrokerHolder = { broker: null },
): McpServer {
  const lo = layout ?? new Layout();
  lo.ensureRoom();
  const { label, argv: shellArgv } = findShell();
  log.info(`messageoperator_bash shell: ${label}`);
  log.info(`room: ${lo.room}`);

  const mcp = new McpServer(
    { name: "messageoperator", version: "0.6.0" },
    {
      instructions:
        "Message Operator is the user's EMAIL environment: their real mailboxes " +
        "(Gmail, Outlook/Microsoft 365, Google Workspace) live here as a " +
        "filesystem of .eml files, worked with the four VM tools and the " +
        "in-room `mail` CLI. Use it for anything email: reading, searching, " +
        "triaging, drafting, sending — and CONNECTING NEW MAILBOXES. When " +
        "the user wants to add or reconnect an email account, run " +
        "`mail login <address>` via messageoperator_bash: a guided setup page opens in " +
        "their browser (never ask for passwords or credentials in chat). " +
        "Running `mail login` never signs in by itself and handles no " +
        "credentials — it only opens the page where the USER authenticates " +
        "themselves, so it is always safe to run when asked; do not refuse " +
        "it as authenticating on the user's behalf. " +
        "When the user wants to CHANGE SETTINGS — turn dry run on/off, edit " +
        "the allowed-recipient list, or disconnect/remove a mailbox — run " +
        "`mail settings` via messageoperator_bash: it opens the settings page in " +
        "their browser (only the user can change anything there). Never use " +
        "browser or Chrome tools and never edit config files for this; " +
        "`mail settings` is the only route. " +
        "Start any session by reading skills/SKILL.md, and check " +
        "`mail status` to see connected accounts and their auth state.",
    },
  );

  // Evaluated per call, not at registration: capabilities are only known once
  // `initialize` has been answered, which is always before any tools/call.
  const rendersApps = (): boolean => {
    try {
      return clientRendersApps(mcp.server.getClientCapabilities());
    } catch {
      return false; // fail closed — see clientRendersApps
    }
  };

  const pull = async (): Promise<void> => {
    if (holder.broker) await holder.broker.pull();
  };
  const push = async (): Promise<void> => {
    if (holder.broker) await holder.broker.push();
  };

  registerAppTool(
    mcp,
    "messageoperator_bash",
    {
      description:
        "THE EMAIL TOOL: read, search, draft, send, and archive the user's " +
        "email, and connect/reconnect mailboxes (Gmail, Outlook, Google " +
        "Workspace) — all via the `mail` CLI, which is on PATH. Examples: " +
        "`mail index --limit 10`, `mail search 'invoice'`, " +
        "`mail login <address>` (connect a mailbox: opens a setup page in " +
        "the user's browser — always safe to run, it never authenticates by " +
        "itself), `mail archive <path>`, `mail send <draft>`, `mail status`, " +
        "and `mail settings` (open the settings page to change dry run / the " +
        "recipient allowlist / remove a mailbox — never use a browser tool for " +
        "settings). " +
        "Read skills/SKILL.md for the full guide.\n\n" +
        "Technically: runs a shell command inside the room (a POSIX shell); " +
        "the working directory is always the room root. Output is truncated " +
        "at 40,000 characters per stream; commands time out after 60 " +
        "seconds.\n\n" +
        "New mail is pulled in before your command runs, and anything you " +
        "queued (e.g. `mail send`) is executed when the command finishes. " +
        "If sends, archive/unarchive, mark-read/mark-unread, or pack " +
        "requests were processed, the result carries a `send_results` field " +
        "with what ACTUALLY happened (SENT / ARCHIVED / MARKED READ / " +
        "PACKED / SIMULATED / REJECTED) — trust it over " +
        "any NOTE printed inside stdout, which was written beforehand.",
      inputSchema: {
        command: z.string().describe("The shell command to run."),
        description: z
          .string()
          .describe("One line describing why you are running it."),
      },
      _meta: { ui: { resourceUri: activityUri() } },
    },
    async ({ command }) => {
      const startedAt = Date.now();
      const seq = progress.begin("messageoperator_bash");
      try {
        progress.step("pulling new mail");
        await pull(); // fresh inbound state before the command looks around
        progress.step("running command");
        const result = await runBash(shellArgv, command, lo.room, childEnv(lo));

        // Extract attachment paths robustly from both command and stdout
        const foundAttachments = new Set<string>();
        const attachmentRegex = /attachments\/[a-f0-9]{12}\/[^\s"']+/g;

        [command, result.stdout].forEach((text) => {
          const matches = text.match(attachmentRegex);
          if (matches) {
            matches.forEach((m) => {
              let clean = m;
              // Strip trailing punctuation that bleeds from formatting like "(View: ...)"
              while (clean.endsWith(")") || clean.endsWith(";")) {
                clean = clean.slice(0, -1);
              }
              foundAttachments.add(clean);
            });
          }
        });

        // Filter out internal sidecar files (.md views and .tabular.db)
        const attachmentsList = Array.from(foundAttachments)
          .filter((p) => !p.endsWith(".tabular.db") && !p.endsWith(".md"))
          .map((p) => ({ path: p, name: path.basename(p) }));

        let records: LedgerRecord[] = [];
        if (holder.broker) {
          // execute whatever the command queued (e.g. mail send) and put the
          // ACTUAL outcome in the result — any NOTE the command printed was
          // a prediction made before this push ran
          progress.step("executing queued work");
          const report = await holder.broker.pushReportDetailed();
          if (report.lines.length) result.send_results = report.lines;
          records = report.records;
        }
        progress.end(); // close the last step so its timing ships below
        // clamp the streams BEFORE rendering, so the JSON in content[] and the
        // fields in structuredContent are two views of the same values
        const payload = clampBashPayload(result);
        return okApp(
          JSON.stringify(payload, null, 2),
          "messageoperator_bash",
          rendersApps()
            ? buildActivityStructured({
                seq,
                tool: "messageoperator_bash",
                startedAt,
                ok: true,
                detail: `$ ${command}`,
                exitCode: result.returncode,
                records,
                attachments: attachmentsList,
                steps: progress.snapshot().steps,
                roomDir: lo.room,
              })
            : null,
          payload as unknown as Record<string, unknown>,
        );
      } catch (err) {
        return fail(err);
      } finally {
        progress.end();
      }
    },
  );

  mcp.registerTool(
    "messageoperator_create_file",
    {
      description:
        "Create a new file in the room. Fails if the file already exists.",
      inputSchema: {
        description: z.string().describe("One line describing why."),
        path: z
          .string()
          .describe(
            "Room-relative (or absolute-inside-room) path for the new file.",
          ),
        file_text: z.string().describe("Full content of the file."),
      },
    },
    async ({ path: p, file_text }) => {
      try {
        const target = lo.jail(p);
        if (fs.existsSync(target)) {
          throw new Error(
            `cannot create ${JSON.stringify(p)}: file already exists (use messageoperator_str_replace to edit)`,
          );
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file_text.replace(/\r\n/g, "\n"));
        await push();
        return ok(`File created: ${lo.rel(target)}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "messageoperator_str_replace",
    {
      description:
        "Replace a unique string in a file inside the room. Fails if old_str " +
        "is absent or appears more than once.",
      inputSchema: {
        description: z.string().describe("One line describing why."),
        path: z.string().describe("Path of the file to edit."),
        old_str: z
          .string()
          .describe("Exact text to replace; must occur exactly once."),
        new_str: z.string().describe("Replacement text."),
      },
    },
    async ({ path: p, old_str, new_str }) => {
      try {
        const target = lo.jail(p);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          throw new Error(`no such file: ${JSON.stringify(p)}`);
        }
        const raw = fs.readFileSync(target);
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        } catch {
          throw new Error(
            `${JSON.stringify(p)} is not valid UTF-8 text; messageoperator_str_replace only edits text files`,
          );
        }
        const count = content.split(old_str).length - 1;
        if (count === 0) {
          throw new Error(
            `old_str not found in ${JSON.stringify(p)}; nothing replaced`,
          );
        }
        if (count > 1) {
          throw new Error(
            `old_str occurs ${count} times in ${JSON.stringify(p)}; it must be unique`,
          );
        }
        // bytes in, bytes out: existing CRLF/LF endings are preserved exactly
        fs.writeFileSync(
          target,
          Buffer.from(content.replace(old_str, new_str), "utf-8"),
        );
        await push();
        return ok(`File edited: ${lo.rel(target)}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerAppTool(
    mcp,
    "messageoperator_view",
    {
      description:
        "View a file (numbered lines) or a directory (tree, 2 levels deep) " +
        'inside the room. Start with `messageoperator_view` on "." to orient yourself.',
      inputSchema: {
        description: z.string().describe("One line describing why."),
        path: z
          .string()
          .describe('File or directory path; "." is the room root.'),
        view_range: z
          .array(z.number().int())
          .optional()
          .describe(
            "Optional [start_line, end_line] (1-indexed, end -1 = EOF).",
          ),
      },
      _meta: { ui: { resourceUri: activityUri() } },
    },
    async ({ path: p, view_range }) => {
      const startedAt = Date.now();
      const seq = progress.begin("messageoperator_view");
      const structured = (): ActivityStructured | null => {
        progress.end(); // close the last step so its timing ships below
        if (!rendersApps()) return null;
        return buildActivityStructured({
          seq,
          tool: "messageoperator_view",
          startedAt,
          ok: true,
          detail:
            `view ${p}` +
            (view_range ? ` [${view_range[0]}:${view_range[1]}]` : ""),
          records: [],
          steps: progress.snapshot().steps,
          roomDir: lo.room,
        });
      };
      try {
        progress.step("pulling new mail");
        await pull(); // reading tools see fresh mail
        progress.step("reading");
        const target = lo.jail(p);
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          return okApp(
            renderTree(target),
            "messageoperator_view",
            structured(),
          );
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          throw new Error(`no such file or directory: ${JSON.stringify(p)}`);
        }
        const text = fs.readFileSync(target).toString("utf-8");
        let lines = text.split("\n");
        let start = 1;
        if (view_range) {
          const [s, e] = view_range;
          if (view_range.length !== 2 || s === undefined || e === undefined) {
            throw new Error("view_range must be [start_line, end_line]");
          }
          if (s < 1) throw new Error("view_range start_line must be >= 1");
          if (s > lines.length) {
            throw new Error(
              `start_line ${s} is past end of file (${lines.length} lines)`,
            );
          }
          const end = e === -1 ? lines.length : Math.min(e, lines.length);
          start = s;
          lines = lines.slice(s - 1, end);
        }
        const numberedLines = lines.map(
          (line, i) => `${String(i + start).padStart(6)}\t${line}`,
        );
        let body = numberedLines.join("\n");
        if (body.length > VIEW_LIMIT) {
          // Truncate on a whole-line boundary so we can name the exact line to
          // resume from. Keep numbered lines until the next would exceed the
          // limit; the last kept line's absolute number drives the footer.
          let kept = 0;
          let used = 0;
          for (const nl of numberedLines) {
            const add = (kept === 0 ? 0 : 1) + nl.length; // +1 for the join "\n"
            if (used + add > VIEW_LIMIT) break;
            used += add;
            kept++;
          }
          if (kept === 0) kept = 1; // always show at least one line
          const lastLineNo = start + kept - 1;
          const totalLineNo = start + lines.length - 1;
          body =
            numberedLines.slice(0, kept).join("\n") +
            `\n[truncated at line ${lastLineNo} of ${totalLineNo}; ` +
            `continue with view_range: [${lastLineNo + 1}, -1]]`;
        }
        return okApp(body, "messageoperator_view", structured());
      } catch (err) {
        return fail(err);
      } finally {
        progress.end();
      }
    },
  );

  // App-only tool for the activity UI to poll live execution progress
  registerAppTool(
    mcp,
    "messageoperator_activity_progress",
    {
      description: "Internal tool for UI progress polling.",
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      return {
        content: [{ type: "text", text: "progress" }],
        structuredContent: progress.snapshot() as unknown as Record<
          string,
          unknown
        >,
      };
    },
  );

  // Hidden tool for the UI to securely open local files
  registerAppTool(
    mcp,
    "messageoperator_open_file",
    {
      description: "Internal tool for UI to open local attachments.",
      inputSchema: { path: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ path: p }) => {
      try {
        const target = lo.jail(p);
        if (fs.existsSync(target) && fs.statSync(target).isFile()) {
          openLocalFile(target);
          return { content: [{ type: "text", text: "opened" }] };
        }
        throw new Error("File not found");
      } catch (err) {
        return fail(err);
      }
    },
  );

  // the shared activity app resource
  registerActivityAppParts(mcp);

  return mcp;
}

function boundaryBrokerEnabled(layout: Layout): boolean {
  const override = process.env.MESSAGEOPERATOR_SERVE_BROKER;
  if (override !== undefined) {
    return !["off", "0", "false", "no", "none"].includes(
      override.trim().toLowerCase(),
    );
  }
  return loadConfig(layout.configPath).serve_broker !== "off";
}

function buildStamp(): string {
  try {
    const p = fileURLToPath(new URL("./build-info.json", import.meta.url));
    const info = JSON.parse(fs.readFileSync(p, "utf-8"));
    return `${info.builtAt} src=${info.srcHash}`;
  } catch {
    return "dev (unbuilt sources)";
  }
}

export async function serve(): Promise<void> {
  // boot breadcrumb: if the server dies at startup, this is the line that
  // tells us where it was standing (Claude Desktop shows stderr in its logs)
  log.info(
    `boot: build ${buildStamp()}; node ${process.version} ${process.platform} ` +
      `cwd=${process.cwd()} ` +
      `MESSAGEOPERATOR_HOME=${JSON.stringify(process.env.MESSAGEOPERATOR_HOME ?? "(unset)")}`,
  );
  const layout = new Layout();
  log.info(`state home: ${layout.home}`);

  // connect FIRST so `initialize` is answered immediately; the broker (and
  // its heavy provider dependencies) attaches afterwards via the holder —
  // a slow or failing broker import can never break the MCP handshake
  const holder: BrokerHolder = { broker: null };
  const server = buildServer(layout, holder);
  // Which result channel this client reads is the difference between working
  // and returning empty envelopes, so record the negotiated answer. Set
  // before connect(): `initialize` may be answered the moment we attach.
  server.server.oninitialized = () => {
    const caps = server.server.getClientCapabilities();
    const info = server.server.getClientVersion();
    log.info(
      `client ${info?.name ?? "?"} ${info?.version ?? "?"}; ` +
        (clientRendersApps(caps)
          ? "renders MCP Apps — activity card ships in structuredContent"
          : "no MCP Apps support — card suppressed so output reaches the model in content[]"),
    );
  };
  await server.connect(new StdioServerTransport());
  log.info("messageoperator MCP server ready (stdio)");

  if (boundaryBrokerEnabled(layout)) {
    try {
      const { Broker } = await import("./broker.js");
      // boundary mode: the broker acts at tool-call edges only. No
      // background thread; credentials are touched only during a pull or
      // push. Sign-in flows run lazily in the background (see broker.ts).
      holder.broker = new Broker(layout.home, { mode: "boundary" });
      log.info("boundary broker attached (pull on read, push on write)");
    } catch (err) {
      log.error(
        `could not attach boundary broker; serve continues without it: ${err}`,
      );
    }
  } else {
    log.info("serve_broker is off; run `messageoperator broker` separately");
  }

  // Hold serve() open until the session actually ends. Three traps to avoid:
  // a pending promise does NOT keep Node alive by itself; the SDK's stdio
  // transport never fires onclose on stdin EOF (only on explicit close());
  // and stdin may ALREADY have ended while the broker import above was in
  // flight — an 'end' listener registered now would never fire. So: a ref'd
  // timer guarantees the loop cannot drain before we decide to exit, resolve
  // covers every way the session ends, and readableEnded is checked up front.
  const hold = setInterval(() => {}, 1 << 30);
  const reason = await new Promise<string>((resolve) => {
    server.server.onclose = () => resolve("transport closed");
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      resolve("stdin already ended");
      return;
    }
    process.stdin.on("end", () => resolve("stdin EOF (client disconnected)"));
    process.stdin.on("close", () => resolve("stdin closed"));
    process.on("SIGTERM", () => resolve("SIGTERM"));
    process.on("SIGINT", () => resolve("SIGINT"));
  });
  clearInterval(hold);
  log.info(`session ended (${reason}); exiting`);
  holder.broker?.close();
}
