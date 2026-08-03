/**
 * Provider-neutral tag model. The whole point: mailbox state is a SET of tags,
 * never a folder tree, and "is this archived?" is the SAME query on every
 * provider — `!tags.has("INBOX")`.
 *
 * Gmail: X-GM-LABELS (a mix of `\System` labels and verbatim user labels).
 * Outlook/Exchange: single-folder residency + color categories collapse into
 * the same set (folder name + categories → tags; Archive folder ⇒ no INBOX).
 */

/** Gmail system label (backslash-prefixed) → canonical provider-neutral tag. */
const GMAIL_SYSTEM = new Map([
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

/**
 * Normalize a Gmail X-GM-LABELS set into canonical tags.
 * - System labels (`\Inbox`, ...) map via GMAIL_SYSTEM.
 * - Gmail category labels (`CATEGORY_PROMOTIONS`) → `CATEGORY/PROMOTIONS`.
 * - User labels pass through verbatim (nested `a/b` preserved).
 * Unknown `\Whatever` system labels are kept, backslash-stripped + uppercased,
 * so nothing is ever silently dropped.
 */
export function gmailLabelsToTags(labels) {
  const out = new Set();
  for (const raw of labels ?? []) {
    if (raw == null) continue;
    const label = String(raw).trim();
    if (!label) continue;
    if (GMAIL_SYSTEM.has(label)) {
      out.add(GMAIL_SYSTEM.get(label));
    } else if (label.startsWith("\\")) {
      out.add(label.slice(1).toUpperCase());
    } else if (label.startsWith("CATEGORY_")) {
      out.add("CATEGORY/" + label.slice("CATEGORY_".length));
    } else {
      out.add(label);
    }
  }
  return out;
}

/** Outlook/Exchange folder name → the tag(s) it contributes. */
function outlookFolderTag(folder) {
  const f = String(folder ?? "").trim();
  const lc = f.toLowerCase();
  if (lc === "inbox") return "INBOX";
  if (lc === "sent items" || lc === "sent") return "SENT";
  if (lc === "drafts") return "DRAFT";
  if (lc === "deleted items" || lc === "trash") return "TRASH";
  if (lc === "junk email" || lc === "junk") return "SPAM";
  if (lc === "archive") return null; // Archive residency ⇒ simply no INBOX tag
  return f ? "FOLDER/" + f : null;
}

/**
 * Map Outlook single-folder residency + categories into the same tag set.
 * The Archive folder contributes NO tag, so `!tags.has("INBOX")` is archived
 * on Outlook exactly as on Gmail.
 */
export function outlookToTags(folder, categories) {
  const out = new Set();
  const ft = outlookFolderTag(folder);
  if (ft) out.add(ft);
  for (const c of categories ?? []) {
    const t = String(c ?? "").trim();
    if (t) out.add("CATEGORY/" + t.toUpperCase());
  }
  return out;
}

/** The one canonical predicate, provider-agnostic. */
export function isArchived(tags) {
  const set = tags instanceof Set ? tags : new Set(tags ?? []);
  return !set.has("INBOX");
}
