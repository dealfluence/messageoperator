// FILE: test/qa_round2_labels.test.ts
/**
 * QA round 2 (2026-07-24), item 7 — CORRECTED.
 *
 * The report's verdict was "FAIL — capability absent, and doc overclaims it",
 * and it recommended either adding a read surface or deleting "labels" from
 * SKILL.md line 106. Both halves are wrong, verified against the live broker DB
 * and the deployed CLI on 2026-07-24:
 *
 *   sqlite> pragma table_info(message);   -> ... labels_json ...
 *   43343 of 43939 rows carry labels_json (42138/42138 on the Gmail account)
 *   label histogram: INBOX 35633, IMPORTANT 24249, SENT 2343,
 *                    Robotframework 1667, Amazon 49, sailmate 35, ... STARRED 1
 *
 *   $ mail read gm:1780803660808284738
 *   Subject: Re: Reaktorin osakkeista
 *   Labels: SENT, STARRED            <-- cmd_read, mail.py
 *
 * So provider labels ARE indexed, STARRED included, and `mail read` DOES print
 * them. SKILL.md's claim is accurate and must not be deleted — hence the first
 * test here, which is a GREEN pin against "fixing" the doc by removing a true
 * statement.
 *
 * Two real gaps remain, and they are what actually produced the QA's
 * observation of starring a message and seeing nothing change:
 *
 *  (a) STALENESS. Gmail All-Mail sync is UID-windowed (syncAllMail: new
 *      arrivals above lastUid, backfill below lowUid). Once a message is
 *      indexed its UID is inside the covered window and is never revisited, so
 *      a label applied LATER is never picked up. The QA starred an
 *      already-indexed message; the single STARRED row in the live DB was
 *      starred before its first index. Second test below.
 *
 *  (b) NO FILTER SURFACE. `mail index` has no labels column and there is no
 *      `mail search --label`, so the natural request ("show me starred mail")
 *      cannot be served even though the data is present. That is a feature
 *      gap, not a defect, and is left to the fix queue rather than asserted
 *      here.
 */

import { describe, expect, it } from "vitest";

import { gmailLabelsToTags, isArchived } from "../src/gmail_labels.js";
import type { MessageRow } from "../src/state.js";
import { makeIndex, makeLayout } from "./helpers.js";

function row(partial: Partial<MessageRow> & { sha: string }): MessageRow {
  return {
    account: "mikko.korpela@gmail.com",
    folder: "Archive",
    filename: "",
    path: "",
    date: "Thu, 26 Oct 2023 07:51:53 GMT",
    epoch: 1698306713,
    from: "Mikko Korpela <mikko.korpela@gmail.com>",
    to: "loimaala@reaktor.fi",
    subject: "Re: Reaktorin osakkeista",
    body: "b",
    metaOnly: true,
    ...partial,
  };
}

describe("provider labels are indexed and readable (QA 2026-07-24 item 7)", () => {
  /** GREEN: the capability the report called absent. Do not delete the doc claim. */
  it("stores and returns a provider label set, STARRED included", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    index.insertMessage(
      row({ sha: "gm:1780803660808284738", labels: ["SENT", "STARRED"] }),
    );
    index.close();

    const reloaded = makeIndex(layout);
    try {
      const stored = reloaded
        .allMessages()
        .find((m) => m.sha === "gm:1780803660808284738");
      expect(stored?.labels).toEqual(["SENT", "STARRED"]);
    } finally {
      reloaded.close();
    }
  });

  it("maps Gmail's \\Starred to a STARRED tag", () => {
    expect(gmailLabelsToTags(["\\Sent", "\\Starred"])).toEqual([
      "SENT",
      "STARRED",
    ]);
    // the canonical archived predicate still works off the same tag set
    expect(isArchived(["SENT", "STARRED"])).toBe(true);
    expect(isArchived(["INBOX", "STARRED"])).toBe(false);
  });

  /**
   * RED: re-indexing a message whose labels changed must update them.
   *
   * This is the store-level unit of the staleness defect. Even once the sync
   * window is widened (or a label-refresh pass added), it only helps if the
   * write path actually overwrites labels_json for an existing sha — the
   * All-Mail loop's own comment notes that "sha/provider-id dedup keeps this
   * idempotent", which is exactly the behaviour that would swallow an update.
   */
  it("updates a stored label set when the same message is re-indexed", () => {
    const layout = makeLayout();
    const index = makeIndex(layout);
    const sha = "gm:1780803660808284738";

    index.insertMessage(row({ sha, labels: ["SENT"] })); // first sync
    index.insertMessage(row({ sha, labels: ["SENT", "STARRED"] })); // user stars it

    const stored = index.allMessages().find((m) => m.sha === sha);
    try {
      expect(
        stored?.labels,
        `a label applied after first index is not reflected; the room keeps ` +
          `reporting ${JSON.stringify(stored?.labels)}`,
      ).toEqual(["SENT", "STARRED"]);
    } finally {
      index.close();
    }
  });
});
