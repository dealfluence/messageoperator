/**
 * SKILL.md is the room's only manual: the agent reads it, then acts on it
 * unattended. A claim in there that the code does not honour is a defect with
 * the same blast radius as a wrong return value — it just fails in the agent's
 * head instead of the process.
 *
 * These tests pin the two claims the 2026-07-24 QA run caught drifting from the
 * implementation. They read the SHIPPED asset (src/room_assets/SKILL.md, the
 * file layout.ts installs into room/skills/) and, where the code owns the
 * ground truth, drive their expectations off the code so the pair cannot drift
 * apart again silently.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SKIP_FOLDERS } from "../src/msgraph.js";

const SKILL_MD = fs.readFileSync(
  fileURLToPath(new URL("../src/room_assets/SKILL.md", import.meta.url)),
  "utf-8",
);

/** SKILL.md split into sentences, whitespace-flattened for regex matching. */
function sentences(markdown: string): string[] {
  return markdown
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?:])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * SKILL.md's PROSE paragraphs, whitespace-flattened, with fenced code blocks
 * removed. Paragraph granularity is what a reader actually takes in as one
 * claim; sentence splitting cannot survive this file's inline code and
 * `path/to.file` tokens.
 */
function prose(markdown: string): string[] {
  return markdown
    .replace(/^```[\s\S]*?^```/gm, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The section under a `## <heading>` line, up to the next `## `. */
function section(markdown: string, headingMatch: RegExp): string {
  const parts = markdown.split(/^## /m);
  const found = parts.find((p) => headingMatch.test(p.split("\n")[0] ?? ""));
  if (!found) throw new Error(`no SKILL.md section matching ${headingMatch}`);
  return found;
}

/**
 * QA 2026-07-24, BUG-3 (medium): a dry-run send consumed the hourly send
 * quota. Timeline was 1 SIMULATED, then 4 real sends, then the 5th real send
 * REJECTED at max_sends_per_hour = 5.
 *
 * This is NOT a code defect. checkPolicy() counts send_simulated alongside
 * send_executed on purpose (intents.ts) and an existing test already locks that
 * in ("enforces the hourly rate limit across executed and simulated sends",
 * test/intents.test.ts) — the report's suggested `>=` vs `>` off-by-one does not
 * exist either: with N prior sends in the window the Nth+1 is allowed until N
 * reaches the cap, so exactly max_sends_per_hour sends get through per hour.
 *
 * What is missing is the disclosure. SKILL.md tells the agent dry_run means "no
 * API calls are made" and never says the simulated attempt still spends quota,
 * so an agent that rehearses a batch under dry run silently burns the real
 * budget it is about to need — the QA run hit exactly that.
 */
describe("SKILL.md dry-run quota disclosure (QA 2026-07-24 BUG-3)", () => {
  const DRY_RUN = /simulat|dry[\s_-]?run/i;
  const QUOTA =
    /max_sends_per_hour|sends? per hour|send quota|rate[\s-]?limit/i;
  const CONSUMES = /count|consume|spend|spent|charge|toward|against|still/i;

  it("states that simulated sends count toward max_sends_per_hour", () => {
    const disclosing = sentences(SKILL_MD).filter(
      (s) => DRY_RUN.test(s) && QUOTA.test(s) && CONSUMES.test(s),
    );
    expect(
      disclosing,
      "SKILL.md must say somewhere that a SIMULATED (dry-run) send still " +
        "counts toward max_sends_per_hour — otherwise rehearsing a batch " +
        "under dry run silently spends the real hourly budget",
    ).not.toEqual([]);
  });
});

/**
 * QA 2026-07-24, BUG-4 (low): SKILL.md claims the broker indexes "the whole
 * Outlook account", but the Graph sync skips well-known folders outright
 * (SKIP_FOLDERS in msgraph.ts, applied in indexHistoryItem). Empirically the
 * MS 365 connector found 132 messages in Junk Email — including three from that
 * same day — while `mail search` returned TOTAL 0 for their senders.
 *
 * The room cannot tell "not in the mailbox" from "not in the sync scope", and
 * SKILL.md actively pushes the agent to trust the index over its own doubts
 * ("If the user thinks mail is 'missing', it almost certainly is not"). So the
 * coverage claim has to name what it excludes.
 *
 * Either fix satisfies this test: disclose the exclusions, or widen the sync
 * scope (then SKIP_FOLDERS shrinks and there is nothing left to disclose).
 */
describe("SKILL.md index-coverage claim (QA 2026-07-24 BUG-4)", () => {
  /**
   * How SKILL.md would name each skipped Graph folder. `null` = the folder is
   * not part of the received-mail coverage claim (an unsent local draft is not
   * mail that arrived), so nothing needs disclosing for it.
   */
  const DISCLOSURE: Record<string, RegExp | null> = {
    junkemail: /junk|spam/i,
    deleteditems: /deleted items|trash|bin\b/i,
    drafts: null,
  };
  const EXCLUDED = /\bnot\b|\bnever\b|\bno\b|exclud|omit|skip|outside|absent/i;

  it("keeps the disclosure map in sync with the Graph sync scope", () => {
    // a folder added to SKIP_FOLDERS must come with a decision about the doc
    expect([...SKIP_FOLDERS].sort()).toEqual(Object.keys(DISCLOSURE).sort());
  });

  it("names the folders the index does not cover", () => {
    const coverage = section(SKILL_MD, /How much mail is here/i);
    expect(coverage).toMatch(/FULL mailbox|whole Outlook/); // the claim under test

    for (const [folder, mention] of Object.entries(DISCLOSURE)) {
      if (!mention) continue;
      const disclosing = sentences(coverage).filter(
        (s) => mention.test(s) && EXCLUDED.test(s),
      );
      expect(
        disclosing,
        `SKILL.md's index-coverage section claims the FULL mailbox is ` +
          `indexed, but msgraph's SKIP_FOLDERS excludes ${folder}. Say so ` +
          `there (or drop it from SKIP_FOLDERS): an agent that cannot see ` +
          `Junk/Deleted Items must not report their contents as nonexistent.`,
      ).not.toEqual([]);
    }
  });

  /**
   * QA round 2 residual (2026-07-24). The carve-out added above satisfies the
   * previous test, but it sits BELOW two sentences that still claim total
   * coverage without qualification:
   *
   *   "it covers the ENTIRE mailbox (100k+ messages fine)"        (~line 25)
   *   "The broker indexes the FULL mailbox (Gmail All Mail /
   *    the whole Outlook account) as metadata"                    (~line 105)
   *
   * The second is the exact phrase round 1 flagged. An agent that skims — and
   * SKILL.md's own framing encourages trusting the index over its doubts — reads
   * the absolute claim and never reaches the paragraph that contradicts it. A
   * qualifier has to travel WITH the claim, in the same sentence.
   */
  it("qualifies every total-coverage claim where it is made", () => {
    // A claim and its qualifier must live in the same paragraph: an agent that
    // reads one paragraph must not come away with the absolute version.
    const TOTAL_CLAIM = /\b(ENTIRE|FULL|whole)\s+(mailbox|Outlook account)\b/;
    const QUALIFIED =
      /except|apart from|other than|exclud|but not|see below|junk|spam|trash|deleted items/i;

    const unqualified = prose(SKILL_MD).filter(
      (p) => TOTAL_CLAIM.test(p) && !QUALIFIED.test(p),
    );
    expect(
      unqualified,
      `${unqualified.length} paragraph(s) claim total index coverage with no ` +
        `qualifier, while msgraph's SKIP_FOLDERS excludes ` +
        `${[...SKIP_FOLDERS].join(", ")}. Append something like ` +
        `"— except Junk and Trash, see below" to each:\n` +
        unqualified.map((p) => `  - ${p}`).join("\n"),
    ).toEqual([]);
  });
});

describe("LICENSE contract", () => {
  it("LICENSE names the current package version", () => {
    const license = fs.readFileSync(
      fileURLToPath(new URL("../LICENSE", import.meta.url)),
      "utf8",
    );
    const { version } = JSON.parse(
      fs.readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    );
    expect(license).toContain(`Message Operator version ${version}`);
  });
});
