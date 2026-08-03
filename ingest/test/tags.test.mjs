import { test } from "node:test";
import assert from "node:assert/strict";

import { gmailLabelsToTags, outlookToTags, isArchived } from "../src/tags.mjs";

test("gmail system labels map to canonical tags", () => {
  const t = gmailLabelsToTags(["\\Inbox", "\\Important", "\\Sent"]);
  assert.deepEqual([...t].sort(), ["IMPORTANT", "INBOX", "SENT"]);
});

test("gmail user labels pass through verbatim, nested preserved", () => {
  const t = gmailLabelsToTags(["Work", "Clients/Acme"]);
  assert.ok(t.has("Work"));
  assert.ok(t.has("Clients/Acme"));
});

test("gmail category labels are namespaced", () => {
  const t = gmailLabelsToTags(["CATEGORY_PROMOTIONS"]);
  assert.ok(t.has("CATEGORY/PROMOTIONS"));
});

test("unknown system labels are kept, never dropped", () => {
  const t = gmailLabelsToTags(["\\SomethingNew"]);
  assert.ok(t.has("SOMETHINGNEW"));
});

test("empty / null labels => archived (no INBOX)", () => {
  const t = gmailLabelsToTags([]);
  assert.equal(t.size, 0);
  assert.equal(isArchived(t), true);
});

test("archived predicate is the same query on gmail and outlook", () => {
  // gmail: message with only \Important (no \Inbox) is archived
  assert.equal(isArchived(gmailLabelsToTags(["\\Important"])), true);
  // gmail: message with \Inbox is not archived
  assert.equal(isArchived(gmailLabelsToTags(["\\Inbox"])), false);
  // outlook: Archive folder ⇒ archived; Inbox folder ⇒ not
  assert.equal(isArchived(outlookToTags("Archive", [])), true);
  assert.equal(isArchived(outlookToTags("Inbox", [])), false);
});

test("outlook folder + categories collapse into the tag set", () => {
  const t = outlookToTags("Inbox", ["Red category", "Follow up"]);
  assert.ok(t.has("INBOX"));
  assert.ok(t.has("CATEGORY/RED CATEGORY"));
  assert.ok(t.has("CATEGORY/FOLLOW UP"));
});

test("outlook custom folder becomes FOLDER/ tag", () => {
  const t = outlookToTags("Projects", []);
  assert.ok(t.has("FOLDER/Projects"));
  assert.equal(isArchived(t), true); // not in inbox
});

test("isArchived accepts a set or an array", () => {
  assert.equal(isArchived(["INBOX"]), false);
  assert.equal(isArchived(new Set(["SENT"])), true);
});
