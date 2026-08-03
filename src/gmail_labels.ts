/**
 * Gmail X-GM-LABELS → provider-neutral tag set, for the broker's All-Mail
 * indexing. Mirrors ingest/src/tags.mjs so the broker and the ingest tool
 * agree on the tag model. "Is archived?" is the one canonical query on every
 * provider: INBOX not in the tag set.
 */

const GMAIL_SYSTEM = new Map<string, string>([
  ["\\Inbox", "INBOX"],
  ["\\Sent", "SENT"],
  ["\\Important", "IMPORTANT"],
  ["\\Starred", "STARRED"],
  ["\\Draft", "DRAFT"],
  ["\\Drafts", "DRAFT"],
  ["\\Trash", "TRASH"],
  ["\\Junk", "SPAM"],
  ["\\Spam", "SPAM"],
]);

/** Normalize a Gmail label set to canonical tags; nothing is silently dropped. */
export function gmailLabelsToTags(
  labels: Iterable<string> | undefined | null,
): string[] {
  const out = new Set<string>();
  for (const raw of labels ?? []) {
    if (raw == null) continue;
    const label = String(raw).trim();
    if (!label) continue;
    const system = GMAIL_SYSTEM.get(label);
    if (system !== undefined) {
      out.add(system);
    } else if (label.startsWith("\\")) {
      out.add(label.slice(1).toUpperCase());
    } else if (label.startsWith("CATEGORY_")) {
      out.add("CATEGORY/" + label.slice("CATEGORY_".length));
    } else {
      out.add(label);
    }
  }
  return [...out];
}

/** The canonical, provider-agnostic predicate. */
export function isArchived(tags: Iterable<string>): boolean {
  return !new Set(tags).has("INBOX");
}
