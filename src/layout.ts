/**
 * Filesystem layout shared by the broker and the MCP server.
 *
 * The two sides share no memory; this module defines the directory contract
 * between them and the path jail used by the MCP tools. Port of the Python
 * POC's layout.py — the state tree under the state home is byte-compatible.
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAIL_FOLDERS = [
  "INBOX",
  "Sent",
  "Drafts",
  "Outbox",
  "Archive",
] as const;
export const MAILDIR_SUBDIRS = ["cur", "new", "tmp"] as const;

export class JailError extends Error {}

export function stateHome(): string {
  // Claude Desktop feeds this from MCPB user_config; guard against the ways
  // that can go wrong: unset, empty, an unresolved "${...}" template passed
  // through literally, or a shell-style "~" the picker never expanded. A
  // relative path would otherwise resolve against the app's cwd (often "/",
  // read-only) and kill the server at first mkdir.
  const raw = (process.env.MESSAGEOPERATOR_HOME || "").trim();
  const fallback = defaultStateHome();
  if (!raw || raw.includes("${")) return fallback;
  let expanded = raw;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/"))
    expanded = path.join(os.homedir(), expanded.slice(2));
  if (!path.isAbsolute(expanded)) return fallback;
  return expanded;
}

/**
 * ~/messageoperator, unless only a legacy ~/mailroom (state written by a
 * pre-rename install) exists — that data keeps being used untouched.
 */
export function defaultStateHome(): string {
  const modern = path.join(os.homedir(), "messageoperator");
  const legacy = path.join(os.homedir(), "mailroom");
  if (!fs.existsSync(modern) && fs.existsSync(legacy)) return legacy;
  return modern;
}

export function sha12(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 12);
}

/**
 * Python's Path.resolve(strict=False): follow symlinks on the longest
 * existing prefix, then append the non-existent remainder. Node's
 * path.resolve() does NOT follow symlinks, and realpathSync throws on
 * missing paths — the jail needs both behaviors combined.
 */
export function resolveFollowingSymlinks(p: string): string {
  const absolute = path.resolve(p);
  const tail: string[] = [];
  let head = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync(head);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
        throw new JailError(
          `cannot resolve path ${JSON.stringify(p)}: ${e.message}`,
        );
      }
      const parent = path.dirname(head);
      if (parent === head) return absolute; // hit the filesystem root
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Locate a real, standalone-invokable Python 3 binary on the host PATH
 * or common installation locations on Windows and macOS.
 */
export function findSystemPython(): string | null {
  const envOverride = process.env.MESSAGEOPERATOR_PYTHON;
  if (envOverride && fs.existsSync(envOverride)) {
    return fs.realpathSync(envOverride);
  }
  const candidates = ["python3", "python"];
  for (const c of candidates) {
    try {
      const cmd = process.platform === "win32" ? `where ${c}` : `which ${c}`;
      const stdout = execSync(cmd, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const firstLine = (stdout.split("\n")[0] ?? "").trim();
      if (firstLine && fs.existsSync(firstLine)) {
        return fs.realpathSync(firstLine);
      }
    } catch {
      // ignore and try next
    }
  }
  if (process.platform === "win32") {
    const winPaths = [
      path.join(
        process.env.USERPROFILE || "",
        "AppData",
        "Local",
        "Programs",
        "Python",
        "Python311",
        "python.exe",
      ),
      path.join(
        process.env.USERPROFILE || "",
        "AppData",
        "Local",
        "Programs",
        "Python",
        "Python312",
        "python.exe",
      ),
      path.join(
        process.env.USERPROFILE || "",
        "AppData",
        "Local",
        "Programs",
        "Python",
        "Python313",
        "python.exe",
      ),
      "C:\\Python311\\python.exe",
      "C:\\Python312\\python.exe",
      "C:\\Python313\\python.exe",
    ];
    for (const p of winPaths) {
      if (fs.existsSync(p)) return fs.realpathSync(p);
    }
  }
  return null;
}

function sameOrUnder(candidate: string, root: string): boolean {
  // dev runs on Windows where drive-letter/dir casing is not canonical;
  // macOS (the target) keeps Python-parity case-sensitive comparison
  const a = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const b = process.platform === "win32" ? root.toLowerCase() : root;
  return a === b || a.startsWith(b + path.sep);
}

export class Layout {
  home: string;
  room: string;
  accounts: string;
  attachments: string;
  bin: string;
  skills: string;
  tagsFile: string;
  untagRequestFile: string;
  brokerDir: string;
  credentials: string;
  ledgerPath: string;
  indexPath: string;
  dbPath: string;
  configPath: string;
  snapshots: string;

  constructor(home?: string) {
    this.home = path.resolve(home || stateHome());
    this.room = path.join(this.home, "room");
    this.accounts = path.join(this.room, "accounts");
    this.attachments = path.join(this.room, "attachments");
    this.bin = path.join(this.room, "bin");
    this.skills = path.join(this.room, "skills");
    this.tagsFile = path.join(this.room, ".tags.jsonl");
    this.untagRequestFile = path.join(this.room, ".untag-request.jsonl");
    this.brokerDir = path.join(this.home, "broker");
    this.credentials = path.join(this.brokerDir, "credentials");
    this.ledgerPath = path.join(this.brokerDir, "ledger.jsonl");
    this.indexPath = path.join(this.brokerDir, "index.json");
    this.dbPath = path.join(this.brokerDir, "store.db");
    this.configPath = path.join(this.brokerDir, "config.json");
    this.snapshots = path.join(this.brokerDir, "snapshots");
  }

  // ---- bootstrap -------------------------------------------------

  ensureRoom(): void {
    for (const d of [
      this.room,
      this.accounts,
      this.attachments,
      this.bin,
      this.skills,
    ]) {
      fs.mkdirSync(d, { recursive: true });
    }
    this.installRoomAsset("mail.py", path.join(this.bin, "mail.py"));
    this.installRoomAsset("SKILL.md", path.join(this.skills, "SKILL.md"));
    // a short-lived POC3 draft shipped a Node CLI; drop stale copies (the
    // target machines only guarantee a system Python, never a system Node)
    fs.rmSync(path.join(this.bin, "mail_cli.mjs"), { force: true });
    this.installPython3Shim();
    this.installMailShim();
  }

  ensureBroker(): void {
    for (const d of [this.brokerDir, this.credentials, this.snapshots]) {
      fs.mkdirSync(d, { recursive: true });
    }
    if (process.platform !== "win32") {
      fs.chmodSync(this.credentials, 0o700);
    }
  }

  ensureAccount(address: string): string {
    // the address is a directory name; agent-supplied values reach here via
    // account/login requests, so refuse anything that could leave accounts/
    if (
      !address.includes("@") ||
      /[/\\:\x00-\x1f]/.test(address) ||
      address.includes("..") ||
      address.startsWith(".")
    ) {
      throw new Error(`unsafe account address ${JSON.stringify(address)}`);
    }
    const acct = path.join(this.accounts, address);
    for (const folder of MAIL_FOLDERS) {
      for (const sub of MAILDIR_SUBDIRS) {
        fs.mkdirSync(path.join(acct, "mail", folder, sub), { recursive: true });
      }
    }
    return acct;
  }

  accountAddresses(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.accounts, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  private installRoomAsset(asset: string, dest: string): void {
    const source = fileURLToPath(
      new URL(`./room_assets/${asset}`, import.meta.url),
    );
    // LF endings: shell shebang scripts reject CRLF
    const text = fs.readFileSync(source, "utf-8").replace(/\r\n/g, "\n");
    fs.writeFileSync(dest, text);
    makeExecutable(dest);
  }

  /**
   * `mail` on bash_tool's PATH is a /bin/sh wrapper that runs mail.cjs.
   * It must call a system Node — see findSystemNode() for why the app's own
   * runtime (process.execPath) cannot be reused here. (Parallels the
   * python3 shim in the Python POC, which faces no such restriction because
   * CPython carries no equivalent of Electron's RunAsNode fuse.)
   */
  private installPython3Shim(): void {
    const dest = path.join(this.bin, "python3");
    const python = findSystemPython();
    if (python) {
      const shim = `#!/bin/sh\nexec "${python.replace(/\\/g, "/")}" "$@"\n`;
      fs.writeFileSync(dest, shim);
      makeExecutable(dest);

      if (process.platform === "win32") {
        const cmdDest = path.join(this.bin, "python3.cmd");
        const cmdShim = `@echo off\n"${python}" %*\n`;
        fs.writeFileSync(cmdDest, cmdShim);
      }
    }
  }

  /**
   * `mail` on bash_tool's PATH runs mail.py with the host's own Python 3.
   * The CLI deliberately targets Python: the deployment machines (macOS +
   * Claude Desktop) always have a system python3, while the app's bundled
   * "Node" is the Electron helper with the RunAsNode fuse disabled — it
   * cannot be invoked as an interpreter from a shell, and no other Node
   * can be assumed to exist.
   */
  private installMailShim(): void {
    const dest = path.join(this.bin, "mail");
    const python = findSystemPython();
    const shim = python
      ? `#!/bin/sh\nexec "${python.replace(/\\/g, "/")}" "$(dirname "$0")/mail.py" "$@"\n`
      : `#!/bin/sh\necho "mail: no system Python 3 found on this machine." >&2\n` +
        `echo "Install Python 3 or set MESSAGEOPERATOR_PYTHON=/path/to/python," >&2\n` +
        `echo "then restart the Message Operator extension." >&2\nexit 1\n`;
    fs.writeFileSync(dest, shim);
    makeExecutable(dest);

    if (process.platform === "win32") {
      const cmdDest = path.join(this.bin, "mail.cmd");
      const cmdShim = python
        ? `@echo off\n"${python}" "%~dp0mail.py" %*\n`
        : `@echo off\necho mail: no system Python 3 found on this machine. >&2\n` +
          `echo Install Python 3 or set MESSAGEOPERATOR_PYTHON=/path/to/python, >&2\n` +
          `echo then restart the Message Operator extension. >&2\nexit 1\n`;
      fs.writeFileSync(cmdDest, cmdShim);
    }
  }

  // ---- path jail -------------------------------------------------

  /**
   * Resolve `p` (absolute or room-relative) and require it under room/.
   * Resolution follows symlinks, so a link pointing outside the room is
   * rejected even though the link itself lives inside.
   */
  jail(p: string): string {
    const raw = String(p);
    const candidate = path.isAbsolute(raw) ? raw : path.join(this.room, raw);
    const resolved = resolveFollowingSymlinks(candidate);
    const room = resolveFollowingSymlinks(this.room);
    if (!sameOrUnder(resolved, room)) {
      throw new JailError(
        `path ${JSON.stringify(p)} is outside the room jail (${room}); ` +
          "only paths under the room are allowed",
      );
    }
    return resolved;
  }

  /** Room-relative POSIX-style path for display and manifests. */
  rel(p: string): string {
    const room = resolveFollowingSymlinks(this.room);
    const resolved = resolveFollowingSymlinks(p);
    return path.relative(room, resolved).split(path.sep).join("/");
  }
}

function makeExecutable(p: string): void {
  if (process.platform !== "win32") {
    const mode = fs.statSync(p).mode;
    fs.chmodSync(p, mode | 0o111);
  }
}
