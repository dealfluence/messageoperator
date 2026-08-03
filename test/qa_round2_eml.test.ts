// FILE: test/qa_round2_eml.test.ts
/**
 * QA round 2 (2026-07-24): the two findings about bytes on the wire and bytes
 * on disk. Both are NOT REPRODUCIBLE as stated; these tests are the guards that
 * record why, so the "fixes" the report proposed are not applied to code that
 * is already correct.
 *
 * ── NEW-8: "stored Graph .eml files use CRCRLF line endings" — NOT REPRODUCIBLE
 *
 * Measured byte-exactly over the live room's stored messages on 2026-07-24
 * (python, binary mode), including the round-2 probes the report cites:
 *
 *   crcrlf=0 crlf= 189 bare_cr=0 bare_lf=0  mikko@adeu.ai/Archive/…79ac6231e655.eml
 *   crcrlf=0 crlf= 559 bare_cr=0 bare_lf=0  mikko@adeu.ai/INBOX/…5bb91d946d6e.eml
 *   crcrlf=0 crlf=1226 bare_cr=0 bare_lf=0  mikko@adeu.ai/INBOX/…ba1a88d2479c.eml
 *   crcrlf=0 crlf= 705 bare_cr=0 bare_lf=0  mikko.korpela@…/INBOX/…5ca492c05a37.eml
 *
 * Every file is clean CRLF on both providers. The report's "705 occurrences of
 * \r\r in the received Graph message" is exactly that file's CRLF count (705),
 * and a Python TEXT-mode write round-trip of those same bytes on Windows
 * produces exactly 705 \r\r — so the doubling happened in the measurement, not
 * in the room. (The same artefact explains the subject parsing as
 * '\r\r\n =?utf-8?B?…': one CR belongs to the folded header, the second was
 * introduced by the reader.)
 *
 * The room writes the provider's bytes verbatim (`fs.writeFileSync(dest, raw)`
 * in store.ts) — the first test pins that, since a future "normalise line
 * endings" change is exactly what WOULD introduce this bug.
 *
 * ── BUG-1 residual: "emit RFC 2231 filename*= on the Graph path" — NOT ACTIONABLE
 *
 * Mailroom already does, on BOTH paths: finalMime() is provider-independent and
 * encodes every attachment parameter through mimeParam(), which emits
 * `filename*=utf-8''…` for any non-ASCII name. Confirmed on disk — the Sent
 * copy Mailroom itself wrote carries:
 *
 *   filename*=utf-8''QA2%20sopimus%20%C3%84%C3%96%20%E2%98%83.docx
 *
 * The RFC 2047 encoded-word the report saw in the RECEIVED Graph message
 * ("filename=\"=?utf-8?B?…?=\"") is Microsoft's: the Graph path posts raw MIME
 * to /me/sendMail and Graph re-encodes the headers server-side before delivery.
 * Nothing in this repo can change that short of abandoning raw-MIME send, so
 * there is no Graph-specific encoder to add — and adding one would be wrong.
 * The report's observation that RFC 2047 in a MIME parameter violates RFC 2047
 * §5 is correct; the violator is Graph.
 */

import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { finalMime } from "../src/intents.js";
import { storeMessage } from "../src/store.js";
import { makeIndex, makeLayout, makeLedger, sampleEml } from "./helpers.js";

function endings(buf: Buffer) {
  const s = buf.toString("latin1");
  const crlf = (s.match(/\r\n/g) ?? []).length;
  return {
    crcrlf: (s.match(/\r\r\n/g) ?? []).length,
    crlf,
    bareCr: (s.match(/\r/g) ?? []).length - crlf,
    bareLf: (s.match(/\n/g) ?? []).length - crlf,
  };
}

describe("stored .eml line endings (QA 2026-07-24 NEW-8, not reproducible)", () => {
  it("writes the provider's bytes verbatim, with no CR doubling", async () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    // sampleEml joins with \r\n, as every provider's raw MIME does
    const raw = sampleEml({
      subject: "QA2-R2 ääkkös ☃",
      body: "line one\r\nline two\r\nline three",
    });
    expect(endings(raw).crcrlf).toBe(0); // the input is clean

    const dest = await storeMessage(layout, index, ledger, {
      account: "mikko@adeu.ai",
      folder: "INBOX",
      raw,
    });
    index.close();
    expect(dest).not.toBeNull();

    const stored = fs.readFileSync(dest!);
    expect(stored).toEqual(raw); // byte-identical, no rewriting
    expect(endings(stored)).toEqual({
      crcrlf: 0,
      crlf: endings(raw).crlf,
      bareCr: 0,
      bareLf: 0,
    });
  });

  it("does not silently repair a genuinely CRCRLF message either", async () => {
    // If a provider ever DID hand us \r\r\n, the room must still store the
    // bytes it received — the .eml is evidence, not a normalised artifact.
    const layout = makeLayout();
    const index = makeIndex(layout);
    const ledger = makeLedger(layout);
    const raw = Buffer.from(
      sampleEml({ subject: "malformed" })
        .toString("latin1")
        .replace(/\r\n/g, "\r\r\n"),
      "latin1",
    );
    const dest = await storeMessage(layout, index, ledger, {
      account: "mikko@adeu.ai",
      folder: "INBOX",
      raw,
    });
    index.close();
    expect(fs.readFileSync(dest!)).toEqual(raw);
  });
});

describe("attachment filename encoding (QA 2026-07-24 BUG-1 residual)", () => {
  const NAME = "QA2 sopimus ÄÖ ☃.docx";

  function mimeWithAttachment(): string {
    const layout = makeLayout();
    const attRel = "attachments/qa/" + NAME;
    const abs = layout.room + "/" + attRel;
    fs.mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(abs, Buffer.from("PKfake", "latin1"));
    return finalMime(layout, sampleEml({ body: "see attached" }), [
      attRel,
    ]).toString("latin1");
  }

  /**
   * GREEN: the room's encoder is already RFC 2231, and it is the ONLY encoder —
   * there is no per-provider branch to fix. What arrives on the Graph path as an
   * RFC 2047 encoded-word was rewritten by Microsoft after this point.
   */
  it("emits RFC 2231 filename*= for a non-ASCII name, provider-independently", () => {
    const mime = mimeWithAttachment();
    const expected =
      "filename*=utf-8''QA2%20sopimus%20%C3%84%C3%96%20%E2%98%83.docx";
    expect(mime).toContain(expected);
    expect(mime).toContain(
      "name*=utf-8''QA2%20sopimus%20%C3%84%C3%96%20%E2%98%83.docx",
    );
    // never the construct RFC 2047 §5 forbids in a parameter value
    expect(mime).not.toMatch(/filename="?=\?utf-8\?/i);
    // the snowman survives as UTF-8 %E2%98%83, the round-1 loss case
    expect(mime).toContain("%E2%98%83");
  });

  it("keeps the header US-ASCII so the latin1 write cannot mangle it", () => {
    const mime = mimeWithAttachment();
    const headerBlock = mime.slice(
      0,
      mime.indexOf("Content-Transfer-Encoding"),
    );
    expect(headerBlock).toMatch(/^[\x00-\x7F]*$/);
  });

  it("leaves a plain ASCII name in the historical quoted form", () => {
    const layout = makeLayout();
    const attRel = "attachments/qa/report.xlsx";
    const abs = layout.room + "/" + attRel;
    fs.mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(abs, Buffer.from("PKfake", "latin1"));
    const mime = finalMime(layout, sampleEml(), [attRel]).toString("latin1");
    expect(mime).toContain('filename="report.xlsx"');
  });
});
