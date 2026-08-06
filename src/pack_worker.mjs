/**
 * Document-extraction worker (worker_threads entry, spawned by pack.ts —
 * never imported, so it stays plain .mjs like ingest/, outside tsc/eslint;
 * its behaviour is pinned by test/pack.test.ts through the pack.ts API).
 *
 * Extraction lives on this thread for two reasons:
 *  - pdf.js (bundled inside pdf-parse) reports recoverable oddities with
 *    console.log. In `serve` the main thread's stdout is the MCP JSON-RPC
 *    channel, and one stray "Warning: ..." line shows up in Claude Desktop
 *    as "Invalid JSON-RPC message from child".
 *  - parsing is CPU-bound and used to stall the main event loop (and every
 *    in-flight tool call) for the duration of a large attachment.
 *
 * Anything the parsers print is rerouted to STDERR here, worker-side: the
 * parent must not consume this worker's stdout, because a consumed worker
 * stdio stream holds the parent's event loop open even after unref() and
 * would hang `broker --once` and the test runner. The parent still opens
 * the worker with `stdout: true` so even a write that slipped past these
 * hooks could only buffer here, never reach the protocol channel.
 */
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("pack_worker must run as a worker thread");

function reroute(text) {
  try {
    fs.writeSync(
      2,
      `${new Date().toISOString()} messageoperator WARN extraction worker: ${text}\n`,
    );
  } catch {
    /* nowhere left to report */
  }
}
for (const name of ["log", "info", "warn", "error", "debug", "trace"]) {
  console[name] = (...args) => reroute(args.map(String).join(" "));
}
process.stdout.write = (chunk, encodingOrCb, cb) => {
  reroute(String(chunk).replace(/\n+$/, ""));
  const done = typeof encodingOrCb === "function" ? encodingOrCb : cb;
  if (typeof done === "function") done();
  return true;
};

// dynamic imports so the console/stdout hooks above are installed before
// either library evaluates (static imports would hoist past the hooks)
const { extractTextFromBuffer } = await import("@adeu/core");
// pdf-parse's package index runs a `module.parent` debug check that
// misfires outside CJS, so import the library file directly (same reason
// as src/types/pdf-parse-lib.d.ts).
const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");

/**
 * Request:  { id: number, kind: "pdf" | "docx", content: Uint8Array }
 * Response: { id: number, ok: true, text: string }
 *         | { id: number, ok: false, error: string }
 */
parentPort.on("message", (msg) => {
  const { id, kind, content } = msg;
  void (async () => {
    try {
      let text;
      if (kind === "pdf") {
        // pdf.js is picky about its input: it reads the underlying
        // ArrayBuffer from position 0 (so byteOffset must be 0), and a Node
        // Buffer — even one satisfying that — makes its fake-worker clone
        // path fail with "bad XRef entry" on PDFs a plain Uint8Array parses
        // fine. Hand it exactly a byteOffset-0 plain Uint8Array.
        const copy = new Uint8Array(content.byteLength);
        copy.set(content);
        const parsed = await pdfParse(copy);
        text = parsed.text ?? "";
      } else if (kind === "docx") {
        // cleanView=false: pending tracked changes surface as CriticMarkup
        text = await extractTextFromBuffer(Buffer.from(content), false);
      } else {
        throw new Error(`unknown extraction kind: ${String(kind)}`);
      }
      parentPort.postMessage({ id, ok: true, text });
    } catch (err) {
      parentPort.postMessage({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});
