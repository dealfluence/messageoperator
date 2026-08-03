/**
 * Honest coverage reporting. The cardinal rule: a reader must never conclude
 * "this message does not exist" when the truth is "not synced yet". Every
 * account carries an explicit sync status and watermark so absence of a hit is
 * always distinguishable from absence of coverage.
 */

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

/** Build a structured coverage report for every known account. */
export function coverageReport(db) {
  const accounts = db
    .prepare("SELECT address, provider FROM account ORDER BY address")
    .all();
  const out = [];
  for (const { address, provider } of accounts) {
    const total = db
      .prepare("SELECT COUNT(*) c FROM message WHERE account=?")
      .get(address).c;
    const range = db
      .prepare(
        "SELECT MIN(date_utc) lo, MAX(date_utc) hi FROM message WHERE account=?",
      )
      .get(address);
    const inbox = db
      .prepare(
        "SELECT COUNT(*) c FROM message m WHERE account=? AND EXISTS " +
          "(SELECT 1 FROM tag t WHERE t.message_id=m.id AND t.tag='INBOX')",
      )
      .get(address).c;
    const archived = total - inbox;
    const sentIndexed = db
      .prepare(
        "SELECT COUNT(*) c FROM message m WHERE account=? AND body_cached=1 AND EXISTS " +
          "(SELECT 1 FROM tag t WHERE t.message_id=m.id AND t.tag='SENT')",
      )
      .get(address).c;
    const inboundCached = db
      .prepare(
        "SELECT COUNT(*) c FROM message m WHERE account=? AND body_cached=1 AND NOT EXISTS " +
          "(SELECT 1 FROM tag t WHERE t.message_id=m.id AND t.tag='SENT')",
      )
      .get(address).c;
    const tagCounts = db
      .prepare(
        "SELECT t.tag tag, COUNT(*) c FROM tag t JOIN message m ON m.id=t.message_id " +
          "WHERE m.account=? GROUP BY t.tag ORDER BY c DESC",
      )
      .all(address);
    const mailboxes = db
      .prepare(
        "SELECT mailbox, uid_validity, last_uid, status, total_expected, updated_utc " +
          "FROM sync_state WHERE account=? ORDER BY mailbox",
      )
      .all(address);

    // account-level status: worst-case across its mailboxes
    let status = "not_started";
    if (mailboxes.length) {
      const statuses = mailboxes.map((m) => m.status);
      if (statuses.includes("auth_blocked")) status = "auth_blocked";
      else if (statuses.includes("in_progress")) status = "in_progress";
      else if (statuses.every((s) => s === "caught_up")) status = "caught_up";
      else status = statuses[0] ?? "not_started";
    }

    out.push({
      account: address,
      provider,
      status,
      total_indexed: total,
      oldest: iso(range.lo),
      newest: iso(range.hi),
      inbox,
      archived,
      sent_bodies_indexed: sentIndexed,
      inbound_bodies_cached: inboundCached,
      tag_counts: tagCounts,
      mailboxes: mailboxes.map((m) => ({
        mailbox: m.mailbox,
        watermark: `${m.uid_validity ?? "?"}:${m.last_uid}`,
        status: m.status,
        server_total: m.total_expected,
        updated: iso(m.updated_utc),
      })),
    });
  }
  return out;
}

/** Render the report as a human-readable string for the CLI. */
export function formatCoverage(report) {
  const lines = [];
  lines.push("Mailroom ingest — coverage report");
  lines.push(
    "(status distinguishes synced vs not-synced: a missing search hit for an",
  );
  lines.push(
    " account that is not 'caught_up' means NOT-YET-SYNCED, not non-existent.)",
  );
  lines.push("");
  if (!report.length) {
    lines.push("  no accounts ingested yet.");
    return lines.join("\n");
  }
  for (const a of report) {
    lines.push(`● ${a.account}  [${a.provider}]  status=${a.status}`);
    lines.push(
      `    indexed: ${a.total_indexed}   inbox: ${a.inbox}   archived: ${a.archived}`,
    );
    lines.push(`    date range: ${a.oldest ?? "—"}  →  ${a.newest ?? "—"}`);
    lines.push(
      `    bodies: sent=${a.sent_bodies_indexed} indexed, inbound=${a.inbound_bodies_cached} cached`,
    );
    const top = a.tag_counts
      .slice(0, 8)
      .map((t) => `${t.tag}:${t.c}`)
      .join("  ");
    if (top) lines.push(`    tags: ${top}`);
    for (const m of a.mailboxes) {
      const pct =
        m.server_total != null && m.server_total > 0
          ? ` (${Math.min(100, Math.round((a.total_indexed / m.server_total) * 100))}% of ${m.server_total})`
          : "";
      lines.push(
        `    mailbox ${m.mailbox}: watermark ${m.watermark}  ${m.status}${pct}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
