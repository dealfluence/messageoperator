/**
 * A1/A2/A4 empirical probe: prove that a Gmail app password over IMAP grants
 * read-only access to [Gmail]/All Mail, per-message X-GM-LABELS, Gmail
 * msg/thread ids, and metadata-only fetch (no body download). Read-only only.
 *
 * Reads the app password from the scratch broker credentials file — never
 * prints it. Usage:
 *   node imap_probe.mjs <address> <credentials-file>
 */
import fs from "node:fs";
import { ImapFlow } from "imapflow";

const [address, pwFile] = process.argv.slice(2);
if (!address || !pwFile) {
  console.error("usage: node imap_probe.mjs <address> <pw-file>");
  process.exit(2);
}
const password = fs.readFileSync(pwFile, "utf-8").replace(/\s+/g, "");

const client = new ImapFlow({
  host: "imap.gmail.com",
  port: 993,
  secure: true,
  auth: { user: address, pass: password },
  logger: false,
});
client.on("error", (e) => console.error("client error:", e.message));

const out = (o) => console.log(JSON.stringify(o));

await client.connect();
try {
  // 1. mailbox list + special-use flags
  const boxes = await client.list();
  const special = boxes
    .filter((b) => b.specialUse)
    .map((b) => ({ path: b.path, use: b.specialUse }));
  out({ step: "list", count: boxes.length, special });

  const allPath =
    boxes.find((b) => b.specialUse === "\\All")?.path ?? "[Gmail]/All Mail";

  // 2. read-only open of All Mail + INBOX; compare counts (archive = the gap)
  const all = await client.mailboxOpen(allPath, { readOnly: true });
  const allExists = all.exists;
  const inbox = await client.mailboxOpen("INBOX", { readOnly: true });
  const inboxExists = inbox.exists;
  out({
    step: "counts",
    allMail: {
      path: allPath,
      exists: allExists,
      uidValidity: String(all.uidValidity),
    },
    inbox: { exists: inboxExists, uidValidity: String(inbox.uidValidity) },
    archived_estimate: allExists - inboxExists,
  });

  // 3. metadata-only fetch from All Mail — NO source/body requested
  await client.mailboxOpen(allPath, { readOnly: true });
  const sample = [];
  let seen = 0;
  let anyArchived = false;
  for await (const msg of client.fetch(
    "1:*",
    {
      uid: true,
      envelope: true,
      internalDate: true,
      size: true,
      flags: true,
      labels: true,
      emailId: true, // X-GM-MSGID
      threadId: true, // X-GM-THRID
      bodyStructure: true,
    },
    { uid: true },
  )) {
    seen += 1;
    const labels = msg.labels ? [...msg.labels] : [];
    const inInbox = labels.includes("\\Inbox") || labels.includes("INBOX");
    if (!inInbox) anyArchived = true;
    if (sample.length < 12) {
      sample.push({
        uid: msg.uid,
        gmailMsgId: msg.emailId,
        gmailThreadId: msg.threadId,
        internalDate: msg.internalDate,
        size: msg.size,
        from: msg.envelope?.from?.map((a) => a.address).join(","),
        subject: msg.envelope?.subject,
        messageId: msg.envelope?.messageId,
        labels,
        inInbox,
        hasStructure: !!msg.bodyStructure,
      });
    }
  }
  out({ step: "fetch_metadata_only", seen, anyArchived, sample });
  out({
    step: "verdict",
    imap_all_mail_readable: true,
    labels_available: sample.every((s) => Array.isArray(s.labels)),
    gmail_ids_available: sample.every(
      (s) => !!s.gmailMsgId && !!s.gmailThreadId,
    ),
    metadata_only_fetch: true,
    archive_visible: anyArchived || allExists > inboxExists,
  });
} finally {
  await client.logout().catch(() => client.close());
}
