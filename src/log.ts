/**
 * Logging to stderr only: stdout is the MCP protocol channel. Claude Desktop
 * surfaces stderr in its MCP server logs.
 *
 * Writes are SYNCHRONOUS (fs.writeSync on fd 2). On POSIX, process.stderr to
 * a pipe is async-buffered, and a process.exit() right after a write silently
 * drops the message — which is exactly when the message matters most (a
 * startup crash under Claude Desktop). Log volume here is tiny; the sync
 * cost is irrelevant next to losing the only evidence of a failure.
 */

import fs from "node:fs";

function line(level: string, message: string): void {
  const text = `${new Date().toISOString()} messageoperator ${level} ${message}\n`;
  try {
    fs.writeSync(2, text);
  } catch {
    try {
      process.stderr.write(text);
    } catch {
      /* nowhere left to report */
    }
  }
}

export const log = {
  info(message: string): void {
    line("INFO", message);
  },
  warn(message: string): void {
    line("WARN", message);
  },
  error(message: string): void {
    line("ERROR", message);
  },
};
