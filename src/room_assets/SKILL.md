# SKILL: working this mail room

You are inside a small computer whose filesystem holds real email. Everything
you can touch is under the room root (your working directory). A broker you
cannot reach syncs mail in and delivers mail out — it acts at the edges of
your tool calls: new mail is pulled in before your command runs, and
anything you queued (like `mail send` or `mail fetch`) is executed when your
command finishes. Between your commands, nothing moves.

## Layout

```
accounts/<address>/mail/{INBOX,Sent,Drafts,Outbox,Archive}/{cur,new,tmp}/
    one RFC 2822 .eml file per message, named <epoch>.<sha12>.eml
    <name>.eml.meta sidecars hold extracted plain text + attachment paths
accounts/<address>/mail/.Cache/cur/  bodies you fetched on demand (see below)
attachments/<msg-sha>/<original-name>   extracted MIME attachments
attachments/<msg-sha>/<name>.pdf.md     readable Markdown view (read-only)
attachments/<msg-sha>/<name>.docx.md    editable Markdown view (see mail pack)
bin/mail                                the mail CLI (already on your PATH)
skills/SKILL.md                         this file
```

The index behind `mail index`/`mail search` is a SQLite database owned by
the broker; it covers the ENTIRE mailbox except Junk/Spam and Trash (100k+
messages fine — see "How much mail is here" below), while the .eml files on
disk are only the bodies downloaded so far.

## The mail CLI

- `mail index --limit 10` — newest messages. TSV columns: date, account,
  from, subject, **id**, path (`-` = body not on disk). Footer:
  `TOTAL n / cursor <c>`; page older with `--before <c>`. `--account A`
  filters. TOTAL is the real mailbox-wide count.
  An account shown as `addr [disconnected]` was REMOVED from Message Operator and its
  mail was kept as a local archive: it is NOT live mail, nothing new arrives,
  and send/archive/fetch on it will be rejected. Never present it as the
  user's current mail — say the mailbox is disconnected and offer
  `mail login <addr>`. `mail status` lists these mailboxes and their counts.
- `mail read <id-or-path>` — headers + body text. For a message whose body
  is not on disk it prints the indexed metadata plus
  `[REMOTE] Body not on disk. Run 'mail fetch <id>' ...` — fetch it, then
  read it in your NEXT command.
- `mail fetch <id> [<id>...]` — queue body downloads for metadata-only
  messages. The broker fetches them when your current command ends; the
  authoritative outcome (FETCHED / FETCH REJECTED) rides in the tool
  result, and the body is readable in your next command.
- `mail search 'invoice -paid' [--limit N] [--account A]` — full-text
  search over subject, addresses, and the body text of downloaded messages.
  Terms AND together, match word prefixes (`invoi` finds `invoices`),
  `"quoted phrases"` and `-negated` terms work; at least one term must be
  positive. Same TSV columns as index.
- `mail reply <id-or-path> body.txt` — threaded reply draft into Drafts;
  prints the draft path. Write the body to a file first (e.g. with
  messageoperator_create_file). The source body must be on disk — fetch it first.
- `mail compose a@b.com to@x.com "Subject" body.txt [--cc addr]... [--bcc addr]...` —
  new draft. `--cc`/`--bcc` may be repeated or take a comma-separated list.
  Editing the draft file before `mail send` is also supported (e.g. adding a
  `Cc:` header or adjusting the body): recipients and content are read from
  the draft itself at send time.
- `mail send <draft-path> [--attach attachments/<sha>/file.pdf]` — queue for
  delivery. Refuses anything not under Drafts/. Attachment paths must live
  under `attachments/` — copy a file there first if you generated it
  elsewhere.
- `mail status` — broker mode, dry_run, allowlist, per-account auth, and
  history-backfill progress (a fresh mailbox indexes in the background;
  TOTAL grows across your commands until the backfill reports caught up).
- `mail login <address> [--provider gmail|microsoft] [--client-id ID]` —
  connect a mailbox (new or existing): a browser opens on the host when your
  current command ends. Microsoft gets an OAuth sign-in; Gmail gets a guided
  page where the user creates an app password and pastes it there. The
  pending URL appears in `mail status` under that account.
- `mail archive <id-or-path> [...]` — remove message(s) from the inbox but
  keep them in the mailbox (zero-inbox workflow). Provider-side: Gmail loses
  the INBOX label, Outlook moves to Archive. NEVER deletes. Queued like
  send: the outcome (ARCHIVED / SIMULATED / REJECTED) rides in the tool
  result. Works by id even for messages whose body is not on disk.
- `mail unarchive <id-or-path> [...]` — put archived message(s) back in the
  inbox. Also works by id alone.
  Folders follow the PROVIDER: if a message was archived or moved back to the
  inbox outside Message Operator (web UI, a filter, a phone), the next sync re-homes the
  room to match. So a message can change folder between your commands without
  you doing anything — re-read `mail index` rather than trusting an earlier
  listing's folder.
- `mail mark-read <id-or-path> [...]` / `mail mark-unread <id-or-path> [...]` —
  set a message's read/unread state in the user's real mailbox (Gmail: the
  IMAP `\Seen` flag; Outlook: the `isRead` property). IMPORTANT: `mail read`
  only DISPLAYS a message — it never marks anything read provider-side, so
  after triaging an inbox the messages you handled still show unread in the
  user's own mail client unless you `mail mark-read` them. Queued like send:
  the outcome (MARKED READ / MARKED UNREAD / SIMULATED / REJECTED) rides in
  the tool result. Works by id even for messages whose body is not on disk.
- `mail pack attachments/<sha>/file.docx.md` — rebase your edits of a .docx
  attachment's Markdown view back into the binary as native Word Tracked
  Changes (author "AI Agent"). Queued like send: the outcome (PACKED /
  PACK REJECTED) rides in the tool result. Only `.docx.md` views pack;
  PDFs are read-only.
- `mail import <absolute-path>` — copy a file from OUTSIDE the room into the
  room's `attachments/` so you can email it. Prints the room-relative path to
  pass to `--attach`. It refuses a path already inside the room (attach those
  directly), and a path belonging to a DIFFERENT machine's sandbox, which it
  cannot reach. Two quite different sources both work:
  (a) **your sandbox** — anything you generated (an xlsx you built in outputs/)
  or a file the user uploaded; see "The two filesystems" below.
  (b) **an ordinary folder on the user's machine** — `~/Documents/report.pdf`,
  `C:\Users\me\Downloads\scan.jpg`. The room runs on the USER'S computer, so any
  path that computer can see is importable. This is how you attach "that file in
  my Downloads folder" when no sandbox is in play at all. If the user names a
  file without giving a path, FIND it first with `messageoperator_bash` (`ls`, `find`) —
  the shell is not limited to the room — then import the path you found. Do not
  tell the user you cannot reach their files; check first.
- `mail export <id-or-attachment-path> --to <absolute-dir> [--name <file>]` —
  copy a RECEIVED attachment out of the room: to your sandbox's outputs (or
  uploads) folder so your skills can open it, or — when no sandbox is in
  play — to any folder that ALREADY EXISTS on the user's machine (e.g. their
  Downloads). Export never creates directories; `mkdir -p` the destination
  first if it is new. `<id>` exports every attachment on the message;
  `--name` picks one.
- `mail settings` — open the Message Operator settings page in the user's browser
  (dry run on/off, allowed recipient domains, removing mailboxes). Run it
  whenever the user wants to change how sending works or disconnect an
  account. You can OPEN the page; only the user can change anything there —
  policy is never yours to change, and never relay settings through chat.

> When the user asks to change settings, turn dry run on/off, edit the
> recipient allowlist, or disconnect/remove a mailbox: run `mail settings`.
> Do NOT use browser/Chrome tools or edit config files, and if you think
> the verb is missing, re-run `mail --help` — it is listed there.

- `mail tag <id-or-path> important` / `mail untag <id-or-path> important` / `mail tags <id-or-path>`.
- `mail table <id> [--sheet S] [--format md|records|jsonl|csv|tsv] [--rows A:B]
[--cols LIST] [--formulas] [--formatted]` — read a spreadsheet or CSV/TSV
  attachment's DATA. See "Working with tabular attachments" below.

## How much mail is here — count and search it correctly

The mailbox is usually far larger than the messages whose bodies are on
disk. The broker indexes the FULL mailbox — except Junk and Trash, see the
next paragraph — (Gmail All Mail / the whole Outlook account) as metadata:
subject, sender, date, labels, an id. It downloads bodies in two ways only:
the last ~30 days of INBOX and Sent at sync time, and anything you
`mail fetch` on demand.

Two provider folders are outside that scope. Junk Email / Spam and Deleted
Items / Trash are **not** indexed and never appear in `mail index` or
`mail search`, on either provider — so a message the user filed in the bin, or
that the provider filtered as spam, is invisible here even though it still
exists in their mailbox. If what they are looking for might be in either place,
say the room cannot see those folders and let them check the provider's own
client; never report it as nonexistent on the strength of a `TOTAL 0`.

Consequences you MUST respect:

- **To count or list messages, use `mail index`** — the footer `TOTAL n` is
  the real count. **Never** answer "how many emails" by counting `.eml`
  files (`find ... *.eml | wc -l`): that counts only downloaded bodies and
  will drastically undercount — a mailbox with `TOTAL 18767` may have ~80
  `.eml` files on disk.
- **Opaque IDs & Shell Quoting:** Message IDs returned by `mail index` can be long, opaque strings containing special characters (e.g. `=`, `-`, `_`). Always shell-quote these IDs or copy-paste them exactly to avoid shell parsing issues (e.g. `mail read "gm:abc_def-123="`).
- On a freshly connected account the index GROWS in the background (the
  broker backfills history in small time-boxed chunks between your
  commands). `mail status` shows the backfill state. Note that Microsoft (Graph) backfill progress in `mail status` only reports "in progress" without a total count, whereas Gmail provides a `~total` magnitude of how many messages remain to be synchronized. A TOTAL that rises between commands is normal and expected.
- **`mail search` matches every message's metadata** (from/to/subject),
  downloaded or not, plus the body text of downloaded ones. It cannot match
  body text that was never fetched.
- **`mail read <id>` tells you when a body is missing** (`[REMOTE]`) and
  `mail fetch <id>` downloads it — available in your NEXT command.
- Fetched bodies live in `accounts/<addr>/mail/.Cache/` under a size quota:
  the least recently used ones may be evicted later (the index row stays;
  just `mail fetch` again). Never treat a missing .eml as missing mail.
- If the user thinks mail is "missing", it almost certainly is not — check
  `mail index`'s `TOTAL` and `mail search` before saying anything is absent.

## Setting up from scratch

If `mail status` shows no accounts, ask the user which mailbox to connect,
then run `mail account add <provider> <address>` — that is the whole setup
you can do. Microsoft finishes in the browser popup on the host; Gmail
additionally needs an app password created on the guided page that
`mail login <address>` opens. Policy (dry_run, allowed recipient domains,
rate limits) is the user's to change — run `mail settings` to open the
settings page in their browser; it is never yours to change.

Note: only AUTHENTICATED accounts count as always-allowed recipients (the
`own addresses` in `mail status`). Registering an address does not make it
sendable-to; the sign-in (or app password) has to complete first.

Exit codes: 0 ok, 1 usage, 2 policy refusal, 3 not found.

## The two filesystems — moving files in and out

Your sandbox (where you run code, generate files, and where the user's
uploads land) and this mail room are TWO SEPARATE filesystems. Your sandbox
cannot see the room's files, and `mail send`/`mail read` cannot see your
sandbox's files. A file in one is invisible to the other until you bridge it:

- **To email a file you generated or the user uploaded** (xlsx, pdf, csv, …):
  it lives in your sandbox, so `mail send --attach <sandbox-path>` will be
  REFUSED ("outside the room"). First run
  `mail import <absolute-sandbox-path>` — it copies the file into
  `attachments/` and prints the room path — then
  `mail send <draft> --attach <that-path>`.
- **To email a file sitting in one of the user's own folders** (Downloads,
  Documents, Desktop): same two steps, no sandbox involved. The room runs on
  their machine, so `mail import /Users/me/Downloads/scan.jpg` (or the Windows
  equivalent) just works. Locate the file with `messageoperator_bash` first if you were
  given a description rather than a path.
  The one case that genuinely CANNOT work is a file that lives only in a
  separate cloud sandbox: that is another machine with no shared disk, and
  `mail import` says so plainly. Then the user has to upload the file into the
  chat instead.
- **To work on a file that arrived by email** (open it, compile several
  received spreadsheets, feed it to a skill): received attachments are
  extracted into `attachments/<sha>/` inside the room, which your sandbox
  cannot read. Run `mail export <id> --to <your-sandbox-outputs-dir>` to copy
  them where your skills can open them. With no sandbox in play, export to an
  existing folder on the user's machine instead. `.pdf`/`.docx` also have
  in-room Markdown views (below); `.xlsx`/`.csv` have `mail table` and a
  `.md` view in-room, so exporting them is only needed for outside tooling.

Pass the ABSOLUTE sandbox path you already know (your outputs/uploads
directory) — do not guess. Never claim a file was emailed or read across the
boundary without bridging it first; that is exactly the step that is easy to
forget.

## Working with document attachments (PDF / DOCX)

`.pdf` and `.docx` attachments get a Markdown view extracted at sync time,
listed by `mail read` next to the attachment:
`Attachment: attachments/<sha>/contract.docx (View: attachments/<sha>/contract.docx.md)`.

**PDF views are read-only.** Read them; never try to pack them.

**DOCX views are two-way.** To propose edits to a Word document someone
mailed in:

1. `mail read <message>` — find the attachment and its `(View: ....md)`.
2. Read the view (`messageoperator_view` tool or `cat`). Pending tracked changes, if any,
   appear as CriticMarkup: `{++insertion++}`, `{--deletion--}`,
   `{>>annotations<<}`.
3. Edit the view with `messageoperator_str_replace` — change exactly the text you want
   changed, leave everything else byte-identical. Don't add CriticMarkup
   yourself; write the text as it should read. NOTE: pack diffs at the
   word/token level, not the sentence level — an edit like "1 year" -> "2
   years" becomes separate token changes ("1"->"2", "year"->"years"), and each
   token must locate a UNIQUE spot in the document. A common word or bare
   number ("one", "1", "year") usually matches many places and gets rejected as
   ambiguous. Prefer changing a longer distinctive phrase, or inserting a whole
   new unique sentence (insertions have no existing text to collide with).
4. `mail pack attachments/<sha>/contract.docx.md` — when your command ends,
   the broker diffs your view against the document, rebases the diff into
   the binary `.docx` as native Word Tracked Changes, and refreshes the view
   so your edits now appear as CriticMarkup. `send_results` carries the real
   outcome: `PACKED` or `PACK REJECTED (reason)`.
5. Reply with the redlined document:
   `mail reply <message> body.txt` then
   `mail send <draft> --attach attachments/<sha>/contract.docx`.

If the pack is REJECTED nothing was changed. Common reasons: `no_changes`
(your view equals the document), `validation_failed` with "Ambiguous match"
(a CHANGED TOKEN matches several places — because matching is word-level,
adding surrounding context does NOT help; instead change a longer distinctive
phrase, or replace/insert unique novel text so the changed tokens themselves
are unique), or `not_found`. There is no match-mode option to set from the
CLI, so any such suggestion in the error text does not apply here. Fix the
view and pack again. Packing is local and repeatable: you can pack, read the
refreshed view, and pack further edits on top; each round adds tracked changes.

## Working with tabular attachments (spreadsheets, CSV/TSV)

Spreadsheet (`.xlsx`/`.xls`/`.xlsm`) and delimited (`.csv`/`.tsv`) attachments
are parsed at sync time into TWO things beside the raw file:

1. A readable `.md` table view, listed by `mail read` next to the attachment
   just like a PDF/DOCX view — `cat` it (or `messageoperator_view`) to see the data
   inline. Large tables are TRUNCATED in this view (first rows + last rows,
   with the true total stated); a truncated view is never the whole table.
2. A structured sidecar the `mail table` verb queries for anything the
   truncated view left out — full slices, specific columns, other formats,
   and the underlying formulas.

**The data is already here.** Once a message body is on disk (fetch it first
if `mail read` shows `[REMOTE]`), its tabular attachments are fully parsed and
local. You never need to copy a spreadsheet out of the room to read or compute
over it — read the `.md` view for a look, and use `mail table` for the rest.

`mail table <id>` with no `--sheet` lists every sheet: index, name, dimensions
(DATA rows × cols — the header row is not counted, so the row count is exactly
the index space `--rows` slices over), and the column schema (name:type). Then
drill in:

- `mail table <id> --sheet <name|index>` — one sheet as a readable Markdown
  table (default). Multi-attachment messages: add `--attachment <filename>`.
- `--rows A:B` — a 0-based, half-open slice over the DATA rows (the rows after
  the header). This is how you read past a truncated view: the omission marker
  tells you the true total, then you slice into it.
- `--cols name,name` or `--cols 0,3,4` — project a subset of columns.
- `--format records` (JSON array of row objects) or `--format jsonl` (one JSON
  object per line) — when you want to PROGRAM against the data rather than read
  it. `--format csv` / `--format tsv` — round-trip the data into your own
  tools.
- By default the machine formats emit the RAW underlying values (numbers as
  numbers), best for computing. Add `--formatted` to get the display text
  instead (e.g. `$1,234.00` rather than `1234`). Spreadsheet cells carry
  their own types; CSV/TSV do not, so their numeric columns are inferred
  strictly — a column is numeric only when EVERY value in it is a plain
  decimal number, and leading-zero codes (`00123`) or mixed columns stay
  strings.
- `--formulas` — show each cell's FORMULA instead of its value. Use this when
  the question is about HOW a number was derived, not just what it is.
- `--header-row N` overrides the auto-detected header row; `--header-row -1`
  treats the sheet as having no header.

Typical flow for "compile these attached spreadsheets into one document": for
each message, `mail table <id>` to see the sheets, then
`mail table <id> --sheet 0 --format records` to pull the data as objects,
reason over it, and generate

`mail send` never sends. It moves your draft to Outbox/ and queues an intent;
the broker checks policy and delivers when your current command finishes.
Your NEXT command sees the outcome: if the send was rejected, the draft is
back in Drafts/ with a `<name>.rejected.txt` beside it explaining why — read
it, fix the draft, send again. If accepted, the draft moved to Sent/.

Note that **`dry_run` is a general policy scope** which simulates outbound sends (`SIMULATED`), folder-state moves like `mail archive` or `mail unarchive` (`SIMULATED ARCHIVE` / `SIMULATED UNARCHIVE`), _and_ read-state marks like `mail mark-read` or `mail mark-unread` (`SIMULATED MARK READ` / `SIMULATED MARK UNREAD`) without making any actual API calls to the email providers.

**A SIMULATED send still counts toward `max_sends_per_hour`.** Dry run skips the
network call, not the policy check, and the attempt is ledgered either way — so
rehearsing a batch under dry run spends the same hourly quota the real sends
will need, and the next send can come back `REJECTED (rate_limited)` although
nothing was ever delivered. Check `mail status` for the limit before using dry
run to test a batch, and count your simulated attempts against it.

Similarly, **`mail fetch` outcomes (FETCHED/REJECTED) are lazy**; they are processed at the end of the current command and their result is printed in the current command's `send_results`. However, the actual fetched body text only becomes available to read (`mail read <id>`) in your NEXT command.

**The authoritative outcome is the `send_results` field of the messageoperator_bash
result that ran `mail send`.** The `NOTE:` line in stdout is a prediction
printed before the send was executed; `send_results` is written after, and
says what actually happened: `SENT` (delivered), `SIMULATED` (dry_run on),
or `REJECTED (reason)` (draft returned with a `.rejected.txt`). The same
field carries FETCHED / ARCHIVED / MARKED READ / MARKED UNREAD / PACKED
outcomes for the other queued verbs.

**A SENT message may not appear in `mail index`/`mail search` for a few
commands** — it only shows up once the provider's own Sent copy syncs back.
NEVER resend because a search came back empty: `send_results: SENT` means the
mail was delivered, and sending again creates a real duplicate email in the
recipient's inbox. To verify a send, trust `send_results` — not a search.

## Auth is lazy — relay it honestly

Accounts may need a human sign-in. `mail status` shows per-address auth:
`ok`, `needs_login` (Microsoft — a sign-in URL may be listed; `mail login`
reopens the browser on the host), or `no_app_password` (Gmail — run
`mail login <address>` to open the guided setup page in the user's
browser). If a send was rejected for auth, tell the user exactly what to do
instead of claiming "sent".

## Adding another mailbox

When the user wants to connect an additional account (work Gmail, a
personal Outlook, a custom-domain mailbox), run
`mail login <address>` — the broker registers the address, detects whether
it lives on Google or Microsoft from the domain's MX records, and opens the
right browser flow on the host. If the address does not appear in
`mail status` on your next command, detection failed: ask the user whether
the mailbox is on Google (Gmail/Workspace) or Microsoft (Outlook/365) and
rerun with `--provider gmail` or `--provider microsoft` (a first Microsoft
account also needs `--client-id`). **Never ask the user to paste an app
password or any credential into the chat** — the browser page is where
secrets go; your job is only to point the user at it and check
`mail status` afterwards.

**Running `mail login` is always safe and expected — it is not you
authenticating.** The command itself only writes a request file; the broker
then opens a page in the user's own browser, where the USER signs in or
pastes their app password themselves. You never see, handle, or enter any
credential at any point. Do not refuse it as "performing authentication on
the user's behalf" — refusing pushes the user toward genuinely worse
options, like pasting passwords into the chat.

## Scripting and Automation

Python 3 is the standard scripting language in this room. The `python3`
command is pre-configured and resolves to the host's Python interpreter.

You are highly encouraged to write custom Python scripts inside the room to
automate advanced email operations (e.g. custom sorting, bulk auto-replies,
or building customized digest files).

To do this:

1. Write your script to a file (e.g. `messageoperator_create_file` at `scripts/digest.py`).
2. Read the filesystem directly under `accounts/` (all messages are
   standard RFC 2822 `.eml` files) — remembering those are only the
   downloaded bodies; drive anything that must be complete off
   `mail index` / `mail search` TSV instead.
3. Call standard Python libraries (`email`, `json`, `re`) for parsing and
   generation.
4. Execute via `messageoperator_bash` with `python3 scripts/digest.py`.

## Composition

index/search output is TSV — pipe it: `mail index --limit 100 | awk -F'\t'
'{print $3}' | sort | uniq -c | sort -rn` gives you a sender histogram.
For counts and histograms drive everything off `mail index` / `mail search`,
never off the `.eml` files on disk — those are only the downloaded bodies
(see "How much mail is here"). `grep` over `accounts/*/mail/` searches just
those downloaded bodies, so it is fine for messages you have opened but will
miss everything else; reach for `mail search` when completeness matters.
