/**
 * Extract searchable plain text from a raw RFC822 message for FTS indexing.
 * Used for SENT bodies (and any on-demand inbound body). Best-effort: a parse
 * failure yields "" so indexing never blocks ingestion.
 */
import { simpleParser } from "mailparser";

export async function bodyText(raw) {
  try {
    const p = await simpleParser(raw);
    const parts = [p.text || ""];
    if (!p.text && p.html) parts.push(String(p.html).replace(/<[^>]+>/g, " "));
    return parts.join("\n").slice(0, 200_000); // cap absurd bodies for the index
  } catch {
    return "";
  }
}
