/**
 * Real Gmail IMAP connection (imapflow), read-only usage only. Mirrors the
 * connection style already proven in src/gmail.ts. The returned client already
 * exposes list/mailboxOpen/search/fetch — exactly the shape backfillAllMail
 * expects — so real runs use it unchanged while tests inject a fake.
 */
import { ImapFlow } from "imapflow";

export class GmailAuthError extends Error {}

export async function connectGmail(address, password) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: address, pass: password },
    logger: false,
  });
  // an unhandled post-connect 'error' would crash the process; just log-swallow
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (err) {
    if (
      err?.authenticationFailed ||
      String(err?.response || "").includes("AUTHENTICATIONFAILED")
    ) {
      throw new GmailAuthError(String(err.responseText || err.message || err));
    }
    throw err;
  }
  return client;
}
