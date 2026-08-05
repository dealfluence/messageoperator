#!/usr/bin/env python3
"""mail - read, search, draft, and queue email from inside the room.

Verbs: index, read, search, fetch, reply, compose, send, status, account,
login, archive, unarchive, pack, tag, tags, help. Exit codes: 0 ok, 1 usage,
2 policy refusal, 3 not found.

This file is stdlib-only and runs on the host's own Python 3 (macOS ships
one; no Node is assumed to exist). It reads the broker's SQLite store
(broker/store.db) READ-ONLY: `mail index`/`mail search` answer from SQL —
with FTS5 when this Python's SQLite has it, and a LIKE scan fallback when
it does not. It never talks to the network: `send`/`fetch`/`archive`/
`login`/... only queue request files that the broker executes when the
current tool call finishes.
"""

import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from email import policy
from email.header import decode_header
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formataddr, formatdate, getaddresses, make_msgid
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath

try:  # utf-8 out even when the host console says otherwise (Windows pipes)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOM = (
    Path(__file__).resolve().parent.parent
    if "__file__" in globals()
    else Path(".").resolve()
)
HOME = ROOM.parent
DB_PATH = HOME / "broker" / "store.db"
TAGS_FILE = ROOM / ".tags.jsonl"
UNTAG_FILE = ROOM / ".untag-request.jsonl"
STATUS_FILE = ROOM / ".broker-status.json"
LOGIN_REQUEST_FILE = ROOM / ".login-request.json"
ACCOUNT_REQUEST_FILE = ROOM / ".account-request.json"
FOLDER_REQUEST_FILE = ROOM / ".folder-request.jsonl"
SETTINGS_REQUEST_FILE = ROOM / ".settings-request.json"
PACK_REQUEST_FILE = ROOM / ".pack-request.jsonl"
FETCH_REQUEST_FILE = ROOM / ".fetch-request.jsonl"
BROKER_STALE_SECS = 90
# Max body bytes emitted per `mail read` call. Kept well under the MCP client's
# tool-result ceiling so a single part never gets clipped by the server-side
# boundary budget. Deliberately hardcoded: mail.py is stdlib-only and decoupled
# from the broker's config, so it does not read MESSAGEOPERATOR_RESULT_BUDGET.
READ_PART_BYTES = 60_000
NO_INDEX = "(index not built yet; broker has not run)"
SIDECAR_SCHEMA_VERSION = 1  # must match tabular_store.ts SIDECAR_SCHEMA_VERSION

OK, USAGE, POLICY_REFUSAL, NOT_FOUND = 0, 1, 2, 3

USAGE_TEXT = """\
usage: mail <verb> [args]

  mail index [--account A] [--limit N] [--before CURSOR]
      List messages, newest first. TSV: date, account, from, subject, id,
      path ("-" = body not on disk; fetch it by id). Footer:
      TOTAL n / cursor <c> - page older with --before <c>.
  mail read <id-or-path> [--part N]
      Print headers and body text of one message. Long bodies are split into
      parts; a footer names the command for the next part. For a message whose
      body is not on disk it prints the indexed metadata and [REMOTE] - run
      'mail fetch <id>' first.
  mail search '<terms>' [--limit N] [--account A]
      Full-text search (subject, addresses, body text of downloaded
      messages). Terms AND together; "quoted phrases" and -negated terms
      work; terms match word prefixes (substrings on hosts without FTS5).
  mail fetch <id> [<id>...]
      Queue body download(s) for metadata-only messages. The broker fetches
      them when this command ends: run 'mail read <id>' in your NEXT
      command. The outcome (FETCHED / FETCH REJECTED) rides in the tool
      result.
  mail reply <id-or-path> <bodyfile> [--all]
      Write a threaded reply draft into the same account's Drafts. Prints
      path. The source message body must be on disk (fetch it first).
      Pass --all to reply-all to all original recipients.
  mail compose <account> <to> <subject> <bodyfile>
      Write a new draft into <account>'s Drafts. Prints path.
  mail send <draft-path> [--attach <room-relative-path>]...
      Queue a draft for sending. Only accepts paths under Drafts/.
  mail draft <draft-path>
      Upload a Drafts/ message into your provider's own Drafts folder (Gmail
      Drafts / Outlook Drafts) so you can review and send it from your normal
      mail client. Never sends. Only accepts paths under Drafts/; the outcome
      (DRAFT UPLOADED / SIMULATED / REJECTED) rides in the tool result.
  mail draft-delete <account> <message-id>
      Reversibly remove a provider-side draft by its Message-ID: the broker
      moves it to Trash / Deleted Items (recoverable). Never hard-deletes.
  mail status
      Show how the broker runs, dry_run, the allowlist, per-account auth
      (including pending sign-in URLs), backfill progress, queued sends.
  mail login [address] [--provider gmail|microsoft] [--client-id ID]
      Connect or re-authenticate a mailbox: a browser opens on the host when
      this tool call ends (Microsoft: OAuth sign-in; Gmail: a guided page
      where the user creates and stores an app password - never ask for the
      password in chat). A new address is registered on the fly; its
      provider is detected from the domain's MX records, or pass --provider
      when detection fails. A first Microsoft account also needs
      --client-id. The pending URL appears in mail status.
  mail archive <id-or-path> [...]
      Archive message(s): remove from the inbox, retain in the mailbox
      (Gmail: INBOX label removed; Outlook: moved to Archive). Never
      deletes. Queued like send; the outcome rides in the tool result.
  mail unarchive <id-or-path> [...]
      Put archived message(s) back in the inbox. Works by id even when the
      body is not on disk.
  mail pack <path>.docx.md
      Rebase your edits of a .docx attachment's Markdown view back into the
      binary .docx as Word tracked changes (author "AI Agent"). Queued like
      send; the outcome (PACKED / PACK REJECTED) rides in the tool result.
      Only .docx views can be packed; PDF views are read-only.
  mail import <absolute-path>
      Copy a file from OUTSIDE the room INTO the room's attachments/ so you can
      attach it to an email. Prints the room-relative path for --attach.
      Works for a file in YOUR sandbox (an xlsx you generated in outputs/, or
      one the user uploaded) AND for an ordinary folder on the user's own
      machine (~/Downloads/scan.jpg) — the room runs on their computer, so any
      path it can see is importable. Only a file that lives solely in a
      separate cloud sandbox is out of reach, and that is reported plainly.
  mail export <id-or-attachment-path> --to <sandbox-dir> [--name <file>]
      Copy a received attachment OUT to your sandbox so skills can open it
      (e.g. to compile received .xlsx files). <id> exports every attachment on
      the message; --name picks one. --to must be your sandbox outputs/uploads
      folder. This is the only command that writes outside the room.
  mail settings
      Open the Message Operator settings page in the user's browser (dry run,
      allowed recipient domains, remove mailboxes). You can open it; only
      the USER can change anything there - never ask them to relay
      settings through chat.
  mail tag <id-or-path> <tag>     Add a tag to a message.
  mail untag <id-or-path> <tag>   Remove a tag from a message.
  mail tags <id-or-path>          List tags of a message.
  mail table <id> [--attachment NAME]
      Read a spreadsheet/CSV attachment's data. With no --sheet, lists each
      sheet's name, dimensions, and column schema. The tabular view is
      produced at sync time; the data is already on disk (no fetch needed if
      the message body was fetched).
  mail table <id> --sheet <name|index> [options]
      Print one sheet. Options:
        --format md|records|jsonl|csv|tsv   default md (readable table)
        --rows A:B      0-based half-open slice over DATA rows (after header)
        --cols LIST     comma-separated column names or 0-based indices
        --formulas      show cell formulas instead of values
        --formatted     records/jsonl/csv/tsv: use display text, not raw values
        --header-row N  override the detected header row (use -1 for none)
"""


def sha12(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()[:12]


def die(code, message):
    print(message, file=sys.stderr)
    raise SystemExit(code)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def tsv_field(value):
    return str(value or "").replace("\t", " ").replace("\n", " ").strip()


def rel(p):
    try:
        return p.resolve().relative_to(ROOM.resolve()).as_posix()
    except ValueError:
        return p.resolve().as_posix()


def norm(path_obj):
    p_str = str(path_obj)
    return p_str.lower() if sys.platform == "win32" else p_str


def looks_like_path(arg):
    """Message ids (sha12 / gm:<n> / ms:<id>) never contain separators."""
    a = str(arg)
    return "/" in a or "\\" in a or Path(a).is_absolute()


def resolve_in_room(arg, *, missing_code=NOT_FOUND, must_exist=True):
    raw = Path(str(arg))
    candidate = raw if raw.is_absolute() else ROOM / raw
    resolved = candidate.resolve()
    room = ROOM.resolve()
    if norm(resolved) != norm(room) and not norm(resolved).startswith(
        norm(room) + os.sep
    ):
        die(POLICY_REFUSAL, f"refusing: {arg!r} is outside the room")
    if must_exist and not resolved.exists():
        die(missing_code, f"not found: {arg}")
    return resolved


def append_jsonl(file, obj):
    with open(file, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj) + "\n")


# ---- bridge (import/export) helpers ---------------------------------
# The Cowork/Claude sandbox and this room are two path-isolated filesystems.
# The sandbox VM cannot see the room, but this room process (a host process)
# CAN read and write the sandbox's outputs/uploads folders. import/export use
# that to move files across the boundary. export is the ONLY operation allowed
# to write outside the room jail, and only into a sandbox mount (below).
ILLEGAL_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# A Cowork sandbox mount: .../local-agent-mode-sessions/<...>/outputs (or
# uploads). export refuses any destination that is not one of these, so a
# prompt-injected attachment can never be written to an arbitrary location.
SANDBOX_MOUNT_RE = re.compile(
    r"local-agent-mode-sessions[/\\].+[/\\](outputs|uploads)(?:[/\\]|$)",
    re.IGNORECASE,
)


def sanitize_attachment_name(name):
    """Strip any directory part and illegal chars from an attachment name."""
    base = str(name).replace("\\", "/")
    base = base[base.rfind("/") + 1 :]
    base = ILLEGAL_FILENAME_CHARS.sub("_", base).strip(" .")
    return base or "attachment"


def is_allowed_export_dir(dest):
    """True when `dest` is inside a Cowork sandbox outputs/uploads mount."""
    d = str(dest)
    if ".." in d.replace("\\", "/").split("/"):
        return False
    return bool(SANDBOX_MOUNT_RE.search(d))


# Markers of a path that belongs to a SEPARATE Claude sandbox VM the room
# cannot reach (a plain claude.ai / Claude Desktop chat, as opposed to a
# Cowork/desktop-deployment session that shares this host's disk). Matched
# against the ORIGINAL argument string, so detection is independent of MSYS
# path mangling (which rewrites '/mnt/...' to 'C:/Program Files/Git/mnt/...'
# on Windows) and works on macOS where the raw path arrives unmangled.
_SANDBOX_VM_MARKERS = (
    "/mnt/user-data/",
    "/mnt/outputs",
    "/mnt/uploads",
    "/sessions/",
    # The sandbox's own HOME and scratch space, which is where an agent
    # naturally writes a file it then tries to attach. Just as unreachable as
    # /mnt, and previously undiagnosed: 'mail import /home/claude/fixtures/x.csv'
    # reported "not a file: C:/Program Files/Git/home/claude/fixtures/x.csv"
    # (QA 2026-07-24, NEW-6).
    "/home/claude/",
    "/users/claude/",  # macOS sandbox home (matched case-insensitively)
    "/tmp/",
)
# Defense-in-depth for the Windows/MSYS case: a sandbox path gets reparented
# under the Git-Bash root, so the resolved path carries a '/Git/...' segment the
# original may not.
_MSYS_REPARENT_MARKERS = (
    "/git/mnt/",
    "/git/sessions/",
    "/git/home/claude/",
    "/git/users/claude/",
)

BRIDGE_UNAVAILABLE_MSG = (
    "file bridge unavailable: this chat's sandbox is a separate machine from "
    "the mail room, with no shared folder between them. mail import/export "
    "only work in the Claude Desktop deployment, where the sandbox and the "
    "room share a disk. Here the room cannot read or write the sandbox's "
    "files. To attach a file you have here, upload it into the chat; to read "
    "a received attachment, ask to read it inline instead of exporting it."
)


def looks_like_sandbox_vm_path(original_arg, resolved_path):
    """True when a path clearly belongs to an unreachable sandbox VM.

    Keyed on path SHAPE, never on reachability: non-existence alone is
    ambiguous (could be a typo), and existence alone is a trap (a VM
    '/tmp/...' or '/mnt/...' can reparent onto a real host dir — the
    false-success bug). Shape is the honest signal.

    KNOWN LIMIT (Windows): the MSYS shell rewrites a POSIX arg before mail.py
    is exec'd, so a sandbox '/tmp/x' arrives already spelled as a real host
    temp path with no sandbox shape left to recognise. Nothing here can catch
    that one; import cannot be made to distinguish it from a genuine host file
    the user pointed at, and import is deliberately allowed to read genuine
    host files (BridgeUnavailableTests.test_real_local_import_still_works).
    """
    orig = str(original_arg).replace("\\", "/").lower()
    if any(m in orig for m in _SANDBOX_VM_MARKERS):
        return True
    res = str(resolved_path).replace("\\", "/").lower()
    return any(m in res for m in _MSYS_REPARENT_MARKERS)


# ---- store access (read-only) ---------------------------------------


def open_store():
    """broker/store.db read-only, or None when absent/unreadable."""
    if not DB_PATH.exists():
        return None
    try:
        uri = DB_PATH.resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=0.5)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error:
        return None


def touch_body(where_col, value):
    """Best-effort LRU touch; the broker may hold the store - never fatal."""
    try:
        conn = sqlite3.connect(DB_PATH, timeout=0.2)
        conn.execute(
            f"UPDATE message SET body_last_access=? WHERE {where_col}=? AND body_cached=1",
            (int(time.time() * 1000), value),
        )
        conn.commit()
        conn.close()
    except sqlite3.Error:
        pass


def row_to_record(row):
    labels = []
    if row["labels_json"]:
        try:
            parsed = json.loads(row["labels_json"])
            if isinstance(parsed, list):
                labels = [str(x) for x in parsed]
        except (ValueError, TypeError):
            pass
    return {
        "sha": row["sha"],
        "account": row["account"],
        "folder": row["folder"] or "",
        "path": row["path"] or "",
        "date": row["date_text"] or "",
        "epoch": row["epoch"] or 0,
        "from": row["from_text"] or "",
        "to": row["to_text"] or "",
        "subject": row["subject"] or "",
        "labels": labels,
        "meta_only": bool(row["meta_only"]),
        "rfc_message_id": row["rfc_message_id"] or "",
    }


def get_by_sha(conn, sha):
    row = conn.execute("SELECT * FROM message WHERE sha=?", (sha,)).fetchone()
    return row_to_record(row) if row else None


DISCONNECTED_MARK = "[disconnected]"


def connected_accounts(status=None):
    """
    Addresses the broker still SYNCS, from room/.broker-status.json.

    Reads `connected_accounts` (config-derived), never `accounts` — that one is
    the set of local maildirs, and removing an account keeps its mail, so a
    removed mailbox stays in `accounts` for as long as its files do. Using it
    here silently disabled this labelling entirely.

    None means "cannot tell" (no status file, unreadable, or written by an
    older broker that predates the field). Callers must treat None as "assume
    everything is connected": wrongly telling the user their live mailbox was
    deleted is worse than staying quiet.
    """
    status = read_status() if status is None else status
    if not status:
        return None
    accounts = status.get("connected_accounts")
    if not isinstance(accounts, list):
        return None
    return {str(a).strip().lower() for a in accounts if str(a).strip()}


def is_disconnected(account, connected):
    """
    True when this message's mailbox is no longer connected.

    Removing an account KEEPS its local mail by default (the settings page
    leaves "also delete the local mail copy" unticked), and the store is what
    `mail index` / `mail search` read — so that mail keeps listing with nothing
    to distinguish it from live mail. Unlabelled, an agent reports a removed
    mailbox's messages as the user's current mail.
    """
    if not account or connected is None:
        return False
    return str(account).strip().lower() not in connected


def disconnected_accounts_in(records, connected):
    """Addresses in these rows whose mailbox is gone, in stable order."""
    seen = []
    for r in records:
        account = r.get("account")
        if is_disconnected(account, connected) and account not in seen:
            seen.append(account)
    return seen


def print_disconnected_note(records, connected):
    """
    Spell out the disconnect once per listing, with the command that undoes it.

    Per-row markers survive an agent piping through `head`; this explains what
    the marker means and how to fix it.
    """
    orphaned = disconnected_accounts_in(records, connected)
    if not orphaned:
        return
    count = sum(1 for r in records if is_disconnected(r.get("account"), connected))
    print(
        f"NOTE: {count} of the rows above are marked {DISCONNECTED_MARK} — their "
        f"mailbox ({', '.join(orphaned)}) was REMOVED from Message Operator. They are a "
        f"local archive, not live mail: nothing new arrives, and archive/send/"
        f"fetch on them will be rejected. Reconnect with "
        f"{' or '.join('`mail login ' + a + '`' for a in orphaned)}."
    )


def retained_disconnected_counts(status):
    """
    [(address, message_count)] for mailboxes the store still holds mail for but
    the broker no longer syncs. Empty when the store is unreadable or the
    status file cannot tell us which accounts are live.
    """
    connected = connected_accounts(status)
    if connected is None:
        return []
    conn = open_store()
    if conn is None:
        return []
    try:
        rows = conn.execute(
            "SELECT account, COUNT(*) FROM message GROUP BY account ORDER BY account"
        ).fetchall()
    except Exception:
        return []
    finally:
        conn.close()
    return [
        (str(account), int(count))
        for account, count in rows
        if str(account).strip().lower() not in connected
    ]


def print_rows(records, connected=None):
    for r in records:
        account = r["account"]
        if is_disconnected(account, connected):
            account = f"{account} {DISCONNECTED_MARK}"
        print(
            "\t".join(
                [
                    tsv_field(r["date"]),
                    tsv_field(account),
                    tsv_field(r["from"]),
                    tsv_field(r["subject"]),
                    tsv_field(r["sha"]),
                    tsv_field(r["path"] or "-"),
                ]
            )
        )


# ---- MIME parsing/formatting (python stdlib email) --------------------


def decode_words(val):
    if not val:
        return ""
    try:
        parts = decode_header(val)
        decoded = []
        for decoded_bytes, charset in parts:
            if isinstance(decoded_bytes, bytes):
                decoded.append(
                    decoded_bytes.decode(charset or "utf-8", errors="replace")
                )
            else:
                decoded.append(str(decoded_bytes))
        return "".join(decoded)
    except Exception:
        return val


def parse_eml_bytes(raw):
    return BytesParser(policy=policy.default).parsebytes(raw)


class _HTMLText(HTMLParser):
    _SKIP = {"script", "style", "head", "title"}
    _BREAK = {"p", "br", "div", "tr", "li", "h1", "h2", "h3", "h4", "blockquote"}

    def __init__(self):
        super().__init__()
        self.parts = []
        self._skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skipping += 1
        if tag in self._BREAK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skipping:
            self._skipping -= 1

    def handle_data(self, data):
        if not self._skipping:
            self.parts.append(data)


def html_to_text(html):
    parser = _HTMLText()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        pass
    text = "".join(parser.parts)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def body_text(msg):
    try:
        part = msg.get_body(preferencelist=("plain", "html"))
    except Exception:
        part = None
    if part is None:
        for cand in msg.walk():
            if cand.get_content_type().startswith("text/"):
                part = cand
                break
    if part is None:
        return "[no text body]"
    try:
        content = part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b""
        content = payload.decode("utf-8", errors="replace")
    if part.get_content_type() == "text/html":
        return html_to_text(content)
    return content.strip()


def _print_body_paginated(text, part):
    """Print one READ_PART_BYTES-sized slice of a message body (1-based part).

    Byte-accurate slicing on a UTF-8 boundary (a split multibyte char at the cut
    is dropped by the decoder). When more remains, a footer names the exact
    command for the next part; stateless — the part number fully determines the
    slice, so nothing is held between calls."""
    data = text.encode("utf-8")
    total_parts = max(1, (len(data) + READ_PART_BYTES - 1) // READ_PART_BYTES)
    if part < 1:
        part = 1
    if part > total_parts:
        print(
            f"[no part {part}: this message body has {total_parts} part(s)]",
            file=sys.stderr,
        )
        raise SystemExit(NOT_FOUND)
    start = (part - 1) * READ_PART_BYTES
    chunk = data[start : start + READ_PART_BYTES].decode("utf-8", errors="ignore")
    print(chunk)
    if total_parts > 1:
        print(
            f"\n[part {part} of {total_parts} "
            f"({len(data)} bytes total, {READ_PART_BYTES} per part). "
            + (
                f"Next: mail read <id-or-path> --part {part + 1}]"
                if part < total_parts
                else "This is the last part.]"
            )
        )


def print_message_file(p, part=1):
    raw = p.read_bytes()
    msg = parse_eml_bytes(raw)
    for name in ["From", "To", "Cc", "Date", "Subject", "Message-ID"]:
        val = msg.get(name)
        if val:
            print(f"{name}: {decode_words(str(val))}")

    meta = p.with_name(p.name + ".meta")
    body = None
    if meta.exists():
        try:
            meta_text = meta.read_text(encoding="utf-8")
            lines = meta_text.splitlines()
            body_start = 0
            attachments = []
            views = set()
            tables = set()
            for i, line in enumerate(lines):
                if line.startswith("X-Messageoperator-Attachments:") or line.startswith("X-Mailroom-Attachments:"):
                    attachments.append(line.split(":", 1)[1].strip())
                elif line.startswith("X-Messageoperator-Attachment-Views:") or line.startswith("X-Mailroom-Attachment-Views:"):
                    views.add(line.split(":", 1)[1].strip())
                elif line.startswith("X-Messageoperator-Attachment-Tables:") or line.startswith("X-Mailroom-Attachment-Tables:"):
                    tables.add(line.split(":", 1)[1].strip())
                elif not line.strip():
                    body_start = i + 1
                    break
            for att in attachments:
                view = att + ".md"
                table = att + ".tabular.db"
                extras = []
                if view in views:
                    extras.append(f"View: {view}")
                if table in tables:
                    extras.append(f"Tables: run 'mail table' on this message")
                if extras:
                    print(f"Attachment: {att} ({'; '.join(extras)})")
                else:
                    print(f"Attachment: {att}")
            body = "\n".join(lines[body_start:]).rstrip()
        except Exception:
            body = None

    print()
    text = body if body else body_text(msg)
    _print_body_paginated(text, part)


def draft_recipients(msg):
    addrs = []
    for name in ["To", "Cc", "Bcc"]:
        for val in msg.get_all(name, []):
            for _, addr in getaddresses([str(val)]):
                if addr and "@" in addr:
                    addrs.append(addr.lower())
    return addrs


def raw_header_value(hdr):
    """The header's literal string value, undoing any RFC2047 encoding the
    parser applied, so message-ids come back as '<id@host>' not '=?utf-8?q?...'."""
    if hdr is None:
        return ""
    s = str(hdr)
    if "=?" in s and "?=" in s:
        # decode any encoded-words back to their literal text
        try:
            parts = decode_header(s)
            out = []
            for chunk, charset in parts:
                if isinstance(chunk, bytes):
                    out.append(chunk.decode(charset or "ascii", errors="replace"))
                else:
                    out.append(chunk)
            s = "".join(out)
        except Exception:
            pass
    return s.strip()


def extract_message_id(hdr):
    """Return the first <...> message-id as literal ASCII, or ''."""
    s = raw_header_value(hdr)
    m = re.search(r"<[^>\s]+>", s)
    return m.group(0) if m else s


# The policy drafts are built under. It is deliberately the STOCK header
# handling: policy.default maps Message-ID to MessageIDHeader (so it serializes
# as a literal "<id@host>") and leaves In-Reply-To / References unstructured,
# which is what preserves them verbatim.
#
# Do not "improve" this by mapping References or In-Reply-To to MessageIDHeader.
# That type holds a SINGLE msg-id and silently discards every token after the
# first, so a reply into an existing thread ships only the root id and deep
# threads mis-thread in Gmail/Outlook. It was mapped that way until 2026-07-24.
# Literal serialization is already handled: MessageIDHeader for Message-ID
# above, and write_draft()'s max_line_length=998 to keep long ids off a
# leading-space continuation line.
#
# Kept as a named function so every draft builder shares one policy and this
# reasoning has somewhere to live.
def _threading_policy():
    from email.headerregistry import HeaderRegistry

    return policy.default.clone(header_factory=HeaderRegistry())


FLOWED_WRAP = 72


def flow_format(text):
    """Wrap a plain-text body for RFC 3676 format=flowed so it survives
    provider-side re-encoding intact and reflows in clients.

    Why: Microsoft Graph / Exchange re-encodes outgoing text/plain bodies as
    quoted-printable with a 76-column SOFT wrap; a soft wrap is '=\\r\\n', and
    some clients render the stray '=' literally, corrupting words at the wrap
    point (e.g. 'dry_run' -> 'dry_r=n'). Keeping every line <= 72 chars means
    no soft wrap is ever needed, so the '=' can never appear. 'format=flowed'
    lets receivers reflow the short lines back to their own width, so the mail
    still looks natural.

    Flowed lines end with a trailing space before the newline; paragraph-final
    ('fixed') lines do not. Lines starting with '>' , 'From ', or ' ' are
    space-stuffed per RFC 3676 3.1. A single long token (e.g. a URL) is left
    whole rather than broken.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    def stuff(s):
        return (
            " " + s
            if (s.startswith(">") or s.startswith("From ") or s.startswith(" "))
            else s
        )

    out = []
    for para in text.split("\n"):
        if para == "":
            out.append("")  # fixed blank line = paragraph break
            continue
        line = ""
        wrapped = []
        for word in para.split(" "):
            cand = word if not line else line + " " + word
            if line and len(stuff(cand)) > FLOWED_WRAP:
                wrapped.append(line)
                line = word
            else:
                line = cand
        if line:
            wrapped.append(line)
        for i, wl in enumerate(wrapped):
            s = stuff(wl)
            out.append(s + " " if i < len(wrapped) - 1 else s)  # flowed vs fixed
    return "\n".join(out)


def new_message(from_addr, to, subject, body):
    msg = EmailMessage(policy=_threading_policy())
    msg["From"] = from_addr
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    domain = from_addr.rsplit("@", 1)[-1] if "@" in from_addr else "messageoperator"
    msg["Message-ID"] = make_msgid(domain=domain)
    # Wrap for format=flowed so provider-side quoted-printable re-encoding
    # never needs a 76-col soft wrap (the source of stray '=' in received
    # mail); receivers reflow the short lines back to their width.
    msg.set_content(flow_format(body))
    msg.replace_header("Content-Type", 'text/plain; charset="utf-8"; format=flowed')
    return msg


def account_of(p):
    try:
        base = (ROOM / "accounts").resolve()
        resolved = p.resolve()
        if resolved == base or base not in resolved.parents:
            return None
        return resolved.relative_to(base).parts[0]
    except Exception:
        return None


def account_dir(address):
    return ROOM / "accounts" / address


def known_accounts():
    base = ROOM / "accounts"
    if not base.is_dir():
        return []
    return sorted(p.name for p in base.iterdir() if p.is_dir())


def write_draft(address, msg):
    # Serialize with a high max_line_length so message-id headers (In-Reply-To,
    # References) stay on their colon line instead of folding onto a leading-
    # space continuation line. The stdlib MessageIDHeader serializer folds a
    # long-ish id right after the colon ("In-Reply-To:\n <id>"), which Gmail/
    # Outlook read as an EMPTY header, breaking threading. set_content() already
    # ran under the normal numeric limit, so the format=flowed body is unchanged.
    raw = msg.as_bytes(policy=msg.policy.clone(max_line_length=998))
    epoch = int(time.time())
    name = f"{epoch}.{sha12(raw)}.eml"
    drafts = account_dir(address) / "mail" / "Drafts" / "cur"
    drafts.mkdir(parents=True, exist_ok=True)
    dest = drafts / name
    dest.write_bytes(raw)
    return dest


# ---- broker status helpers -------------------------------------------


def read_status():
    if not STATUS_FILE.exists():
        return None
    try:
        return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def broker_age_seconds(status):
    if not status or not status.get("ts"):
        return None
    try:
        ts_str = status["ts"].replace("Z", "+00:00")
        ts = datetime.fromisoformat(ts_str)
    except Exception:
        return None
    return (datetime.now(timezone.utc) - ts).total_seconds()


def broker_mode(status):
    return (status or {}).get("mode") or "daemon"


def broker_running(status):
    if not status:
        return False
    if broker_mode(status) == "boundary":
        return True
    age = broker_age_seconds(status)
    return age is not None and age <= BROKER_STALE_SECS


def predict_send(status, recipients):
    if not broker_running(status):
        return (
            "the broker does not appear to be running (run `messageoperator serve` or "
            "`messageoperator broker`); the send is queued and will go out once it runs"
        )
    own = set(status.get("own_addresses", []))
    allowed = set(status.get("allowed_recipient_domains", []))
    blocked = [
        r for r in recipients if r not in own and r.rsplit("@", 1)[-1] not in allowed
    ]
    if blocked:
        return (
            f"this send will be REJECTED: recipient(s) {', '.join(blocked)} are outside "
            f"the allowlist (allowed domains: {', '.join(sorted(allowed)) or 'none'}; "
            f"your own addresses {', '.join(sorted(own)) or 'none'} are always allowed). "
            "The draft will return to Drafts with a .rejected.txt."
        )
    if status.get("dry_run") is not False:
        return (
            "dry_run is ON, so this will be SIMULATED (ledger: send_simulated), not "
            "actually delivered. Set dry_run=false (extension settings or "
            "broker/config.json) to send for real. Note that a simulated send "
            "still counts toward max_sends_per_hour."
        )
    if broker_mode(status) == "boundary":
        return (
            "this will be DELIVERED when the current tool call finishes — the tool "
            "result's send_results field will state the actual outcome (this NOTE "
            "is a prediction; trust send_results)."
        )
    return "this will be DELIVERED on the next broker cycle (within ~15s)."


# ---- verbs ---------------------------------------------------------


def cmd_index(args):
    account = None
    limit = 20
    before = None
    it = iter(args)
    for arg in it:
        if arg == "--account":
            try:
                account = next(it)
            except StopIteration:
                die(USAGE, "mail index: --account needs a value")
        elif arg == "--limit":
            try:
                limit = int(next(it))
            except (ValueError, StopIteration):
                die(USAGE, "mail index: --limit needs a number")
        elif arg == "--before":
            try:
                before = next(it)
            except StopIteration:
                die(USAGE, "mail index: --before needs a cursor")
        else:
            die(USAGE, f"mail index: unknown argument {arg!r}")

    conn = open_store()
    if conn is None:
        print(f"TOTAL 0 / cursor - {NO_INDEX}")
        return OK
    try:
        where = []
        params = []
        if account:
            where.append("account=?")
            params.append(account)
        if before:
            head, _, tail = str(before).partition(".")
            try:
                epoch = int(head)
            except ValueError:
                die(USAGE, f"mail index: bad cursor {before!r}")
            where.append("(epoch < ? OR (epoch = ? AND sha < ?))")
            params.extend([epoch, epoch, tail])
        where_sql = f" WHERE {' AND '.join(where)}" if where else ""
        total = conn.execute(
            "SELECT COUNT(*) FROM message" + (" WHERE account=?" if account else ""),
            [account] if account else [],
        ).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM message{where_sql} ORDER BY epoch DESC, sha DESC LIMIT ?",
            params + [max(0, limit)],
        ).fetchall()
        records = [row_to_record(r) for r in rows]
        connected = connected_accounts()
        print_rows(records, connected)
        cursor = f"{records[-1]['epoch']}.{records[-1]['sha']}" if records else "-"
        print(f"TOTAL {total} / cursor {cursor}")
        print_disconnected_note(records, connected)
        return OK
    finally:
        conn.close()


def parse_query(query):
    terms = []
    pattern = re.compile(r'(-)?(?:"([^"]*)"|(\S+))')
    for match in pattern.finditer(query):
        negated = bool(match.group(1))
        text = match.group(2) if match.group(2) is not None else match.group(3)
        if text:
            terms.append({"text": text, "negated": negated})
    return terms


def fts_match_expression(terms):
    """Positives AND together (prefix phrases); negatives chain with NOT, grouped by OR."""
    groups = []
    current_group = []
    for t in terms:
        if t["text"] == "OR" and not t["negated"]:
            if current_group:
                groups.append(current_group)
                current_group = []
        else:
            current_group.append(t)
    if current_group:
        groups.append(current_group)

    groups = [g for g in groups if g]
    if not groups:
        return ""

    def quote(t):
        return '"' + t.replace('"', '""') + '" *'

    group_exprs = []
    for group in groups:
        pos = [t for t in group if not t["negated"]]
        neg = [t for t in group if t["negated"]]
        expr_parts = [quote(t["text"]) for t in pos]
        expr = " ".join(expr_parts)
        for t in neg:
            expr += f" NOT {quote(t['text'])}"
        if len(groups) > 1:
            group_exprs.append(f"({expr})")
        else:
            group_exprs.append(expr)

    return " OR ".join(group_exprs)


def search_like(conn, terms, account, limit):
    """LIKE fallback: substring AND/NOT over the same searchable columns, grouped by OR."""
    groups = []
    current_group = []
    for t in terms:
        if t["text"] == "OR" and not t["negated"]:
            if current_group:
                groups.append(current_group)
                current_group = []
        else:
            current_group.append(t)
    if current_group:
        groups.append(current_group)

    groups = [g for g in groups if g]
    if not groups:
        return []

    hay = "(subject || ' ' || from_text || ' ' || to_text || ' ' || body_text)"
    group_clauses = []
    params = []
    for group in groups:
        and_clauses = []
        for t in group:
            pattern = "%" + re.sub(r"([%_\\])", r"\\\1", t["text"]) + "%"
            and_clauses.append(
                f"{hay} {'NOT ' if t['negated'] else ''}LIKE ? ESCAPE '\\'"
            )
            params.append(pattern)
        group_clauses.append(f"({' AND '.join(and_clauses)})")

    where_expr = f"({' OR '.join(group_clauses)})"
    where = [where_expr]
    if account:
        where.append("account=?")
        params.append(account)
    return conn.execute(
        f"SELECT * FROM message WHERE {' AND '.join(where)} ORDER BY epoch DESC LIMIT ?",
        params + [max(0, limit)],
    ).fetchall()


def cmd_search(args):
    if not args:
        die(USAGE, "usage: mail search '<terms>' [--limit N] [--account A]")
    query = args[0]
    limit = 20
    account = None
    it = iter(args[1:])
    for arg in it:
        if arg == "--limit":
            try:
                limit = int(next(it))
            except (ValueError, StopIteration):
                die(USAGE, "mail search: --limit needs a number")
        elif arg == "--account":
            try:
                account = next(it)
            except StopIteration:
                die(USAGE, "mail search: --account needs a value")
        else:
            die(USAGE, f"mail search: unknown argument {arg!r}")

    conn = open_store()
    if conn is None:
        print(f"TOTAL 0 {NO_INDEX}")
        return OK
    try:
        terms = parse_query(query)
        if not terms:
            die(USAGE, "mail search: empty query")
        if not any(not t["negated"] for t in terms):
            die(USAGE, "mail search: needs at least one non-negated term")
        rows = None
        try:
            match = fts_match_expression(terms)
            sql = (
                "SELECT m.* FROM message_fts f JOIN message m ON m.id = f.rowid "
                "WHERE message_fts MATCH ?"
                + (" AND m.account=?" if account else "")
                + " ORDER BY rank, m.epoch DESC LIMIT ?"
            )
            params = [match] + ([account] if account else []) + [max(0, limit)]
            rows = conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError:
            # no message_fts table, or this Python's SQLite lacks the fts5
            # module: same answer from a LIKE scan, just slower
            rows = search_like(conn, terms, account, limit)
        records = [row_to_record(r) for r in rows]
        connected = connected_accounts()
        print_rows(records, connected)
        print(f"TOTAL {len(records)}")
        print_disconnected_note(records, connected)
        return OK
    finally:
        conn.close()


def cmd_read(args):
    part = 1
    positional = []
    it = iter(args)
    for a in it:
        if a == "--part":
            try:
                part = int(next(it))
            except (ValueError, StopIteration):
                die(USAGE, "mail read: --part needs a number")
        else:
            positional.append(a)
    if len(positional) != 1:
        die(USAGE, "usage: mail read <id-or-path> [--part N]")
    arg = positional[0]

    if looks_like_path(arg):
        p = resolve_in_room(arg)
        if not p.is_file():
            die(NOT_FOUND, f"not a file: {arg}")
        print_message_file(p, part)
        touch_body("path", rel(p))
        return OK

    conn = open_store()
    record = get_by_sha(conn, arg) if conn else None
    if conn:
        conn.close()
    if record is None:
        die(NOT_FOUND, f"not found: {arg} (no such file or message id)")
    orphaned = is_disconnected(record["account"], connected_accounts())
    if record["path"]:
        p = ROOM / PurePosixPath(record["path"])
        if p.is_file():
            if orphaned:
                print(
                    f"NOTE: {record['account']} was REMOVED from Message Operator; this is a "
                    f"local archive copy, not live mail. Reconnect with "
                    f"`mail login {record['account']}`."
                )
                print()
            print_message_file(p, part)
            touch_body("sha", record["sha"])
            return OK
    if record["date"]:
        print(f"Date: {record['date']}")
    if record["from"]:
        print(f"From: {record['from']}")
    if record["to"]:
        print(f"To: {record['to']}")
    print(f"Subject: {record['subject']}")
    print(f"Account: {record['account']}")
    if record["labels"]:
        print(f"Labels: {', '.join(record['labels'])}")
    print()
    if orphaned:
        # `mail fetch` would be REJECTED (unknown_account) for a removed
        # mailbox, so pointing at it would loop the agent through a command
        # that cannot succeed
        print(
            f"[DISCONNECTED] Body not on disk, and {record['account']} was REMOVED "
            f"from Message Operator — it cannot be downloaded. Only the metadata above was "
            f"kept. Reconnect with `mail login {record['account']}` to make this "
            f"message readable again."
        )
    else:
        print(
            f"[REMOTE] Body not on disk. Run 'mail fetch {record['sha']}' to download it; "
            "it arrives when that command ends — read it in your NEXT command."
        )
    return OK


def cmd_fetch(args):
    if not args:
        die(USAGE, "usage: mail fetch <id> [<id>...]")
    conn = open_store()
    if conn is None:
        die(NOT_FOUND, f"mail fetch: {NO_INDEX}")
    queued = 0
    failures = 0
    try:
        for arg in args:
            record = get_by_sha(conn, arg)
            if record is None:
                print(f"error: {arg}: no such message id", file=sys.stderr)
                failures += 1
                continue
            if record["path"] and (ROOM / PurePosixPath(record["path"])).is_file():
                print(f"already on disk: {record['path']} (no fetch needed)")
                continue
            append_jsonl(FETCH_REQUEST_FILE, {"sha": record["sha"], "ts": now_iso()})
            print(f"FETCH queued: {record['sha']} ({tsv_field(record['subject'])})")
            queued += 1
    finally:
        conn.close()
    if queued:
        print(
            "NOTE: the broker downloads queued bodies when this command ends. "
            "Run 'mail read <id>' in your NEXT command; the outcome (FETCHED / "
            "FETCH REJECTED) rides in the tool result."
        )
    return NOT_FOUND if failures else OK


def _resolve_reply_recipients(src_msg, account_addr):
    """Determine the primary reply-to header string for a given source message and active account.

    If the source message's From/Reply-To matches the active account address (e.g. replying
    to a sent message), resolve recipients from the original message's To/Cc headers
    excluding the account address itself (unless it was the sole recipient).
    """
    account_lower = account_addr.lower() if account_addr else ""
    raw_reply_to = src_msg.get("Reply-To") or src_msg.get("From") or ""
    sender_addrs = [
        addr.lower() for _, addr in getaddresses([str(raw_reply_to)]) if addr
    ]

    is_sent_by_me = bool(sender_addrs) and all(
        a == account_lower for a in sender_addrs
    )

    if is_sent_by_me:
        to_pairs = (
            getaddresses([str(t) for t in src_msg.get_all("To")])
            if src_msg.get_all("To")
            else []
        )
        non_self_to = [
            formataddr((name, addr))
            for name, addr in to_pairs
            if addr and addr.lower() != account_lower
        ]
        if non_self_to:
            return ", ".join(non_self_to)

        cc_pairs = (
            getaddresses([str(c) for c in src_msg.get_all("Cc")])
            if src_msg.get_all("Cc")
            else []
        )
        non_self_cc = [
            formataddr((name, addr))
            for name, addr in cc_pairs
            if addr and addr.lower() != account_lower
        ]
        if non_self_cc:
            return ", ".join(non_self_cc)

        all_to = [formataddr((name, addr)) for name, addr in to_pairs if addr]
        if all_to:
            return ", ".join(all_to)

    return str(raw_reply_to)


def cmd_reply(args):
    reply_all = False
    if "--all" in args:
        reply_all = True
        args = [a for a in args if a != "--all"]
    if len(args) != 2:
        die(USAGE, "usage: mail reply <id-or-path> <bodyfile> [--all]")
    src = args[0]
    if not looks_like_path(src):
        conn = open_store()
        record = get_by_sha(conn, src) if conn else None
        if conn:
            conn.close()
        if record is not None:
            if not record["path"]:
                die(
                    POLICY_REFUSAL,
                    f"refusing: the body of {src} is not on disk — run 'mail fetch {src}' first, then reply",
                )
            src = record["path"]
    src_path = resolve_in_room(src)
    body_file = resolve_in_room(args[1])
    address = account_of(src_path)
    if not address:
        die(POLICY_REFUSAL, "refusing: can only reply to messages under accounts/")

    src_msg = parse_eml_bytes(src_path.read_bytes())
    body = body_file.read_text(encoding="utf-8", errors="replace")

    reply_to = _resolve_reply_recipients(src_msg, address)
    subject = src_msg.get("Subject") or ""
    if not re.match(r"(?i)^\s*re\s*:", str(subject)):
        subject = "Re: " + str(subject)

    to_str = str(reply_to)
    cc_str = None

    if reply_all:
        seen = set()
        if address:
            seen.add(address.lower())

        to_addrs = []
        if reply_to:
            for name, addr in getaddresses([str(reply_to)]):
                if addr and addr.lower() not in seen:
                    to_addrs.append(formataddr((name, addr)))
                    seen.add(addr.lower())

        if src_msg.get("Reply-To") and src_msg.get_all("From"):
            for _, addr in getaddresses([str(f) for f in src_msg.get_all("From")]):
                if addr:
                    seen.add(addr.lower())

        if src_msg.get_all("To"):
            for name, addr in getaddresses([str(t) for t in src_msg.get_all("To")]):
                if addr and addr.lower() not in seen:
                    to_addrs.append(formataddr((name, addr)))
                    seen.add(addr.lower())

        if not to_addrs and reply_to:
            to_addrs.append(str(reply_to))

        cc_addrs = []
        if src_msg.get_all("Cc"):
            for name, addr in getaddresses([str(c) for c in src_msg.get_all("Cc")]):
                if addr and addr.lower() not in seen:
                    cc_addrs.append(formataddr((name, addr)))
                    seen.add(addr.lower())

        if to_addrs:
            to_str = ", ".join(to_addrs)
        if cc_addrs:
            cc_str = ", ".join(cc_addrs)

    msg = new_message(address, to_str, str(subject), body)
    if cc_str:
        msg["Cc"] = cc_str

    # Message-ID / In-Reply-To / References must be RAW ASCII message-ids in
    # angle brackets — never RFC2047 word-encoded. Extract the literal string and
    # set these headers so the raw value is preserved verbatim.
    msg_id = extract_message_id(src_msg.get("Message-ID"))
    if msg_id:
        # `msg` was built under _threading_policy(), which uses HeaderRegistry
        # without mapping References to single-value MessageIDHeader — so plain string
        # assignment serializes literal space-separated "<id@host>" values.
        msg["In-Reply-To"] = msg_id
        prior_refs = raw_header_value(src_msg.get("References"))
        if not prior_refs:
            prior_refs = raw_header_value(src_msg.get("In-Reply-To"))
        refs = prior_refs.split() if prior_refs else []
        if msg_id not in refs:
            refs.append(msg_id)
        msg["References"] = " ".join(refs)

    dest = write_draft(address, msg)
    print(rel(dest))
    return OK


def cmd_compose(args):
    if len(args) != 4:
        die(USAGE, "usage: mail compose <account> <to> <subject> <bodyfile>")
    address, to, subject, body_arg = args
    if not account_dir(address).is_dir():
        die(
            NOT_FOUND,
            f"no such account: {address} (known: {', '.join(known_accounts()) or 'none'})",
        )
    body_file = resolve_in_room(body_arg)
    body = body_file.read_text(encoding="utf-8", errors="replace")
    msg = new_message(address, to, subject, body)
    dest = write_draft(address, msg)
    print(rel(dest))
    return OK


def cmd_send(args):
    if not args:
        die(USAGE, "usage: mail send <draft-path> [--attach <room-relative-path>]...")
    draft_arg = args[0]
    attachments = []
    it = iter(args[1:])
    for arg in it:
        if arg == "--attach":
            try:
                att = next(it)
            except StopIteration:
                die(USAGE, "mail send: --attach needs a path")
            attachments.append(att)
        else:
            die(USAGE, f"mail send: unknown argument {arg!r}")

    draft = resolve_in_room(draft_arg)
    address = account_of(draft)
    in_drafts = False
    if address:
        try:
            rel_parts = (
                draft.resolve()
                .relative_to((ROOM / "accounts" / address).resolve())
                .parts
            )
            in_drafts = (
                len(rel_parts) >= 2
                and rel_parts[0] == "mail"
                and rel_parts[1] == "Drafts"
            )
        except ValueError:
            pass

    if not in_drafts:
        die(
            POLICY_REFUSAL,
            f"refusing: send only accepts drafts under accounts/<account>/mail/Drafts/ (got {draft_arg!r})",
        )

    att_rel = []
    for att in attachments:
        att_path = resolve_in_room(att)
        if not att_path.is_file():
            die(NOT_FOUND, f"attachment is not a file: {att}")
        r = rel(att_path)
        if not r.startswith("attachments/"):
            die(
                POLICY_REFUSAL,
                f"refusing: attachments must live under attachments/ (copy the file there first): {att}",
            )
        att_rel.append(r)

    raw = draft.read_bytes()
    recipients = draft_recipients(parse_eml_bytes(raw))

    outbox = account_dir(address) / "mail" / "Outbox"
    outbox_new = outbox / "new"
    outbox_tmp = outbox / "tmp"
    outbox_new.mkdir(parents=True, exist_ok=True)
    outbox_tmp.mkdir(parents=True, exist_ok=True)

    dest = outbox_new / draft.name
    intent = {
        "account": address,
        "sha256_12": sha12(raw),
        "attachments": att_rel,
        "ts": now_iso(),
    }

    draft.replace(dest)
    tmp_intent = outbox_tmp / (draft.name + ".intent.json")
    tmp_intent.write_text(json.dumps(intent, indent=2), encoding="utf-8")
    tmp_intent.replace(outbox_new / (draft.name + ".intent.json"))

    print(f"INTENT queued: {rel(dest)}")
    print("NOTE: " + predict_send(read_status(), recipients))
    return OK


def cmd_draft(args):
    # Upload an existing Drafts/ message to the provider's own Drafts folder
    # (Gmail Drafts / Outlook Drafts) so the human can review and send it from
    # their normal mail client. NEVER a send: it queues an upload intent into
    # a SEPARATE DraftBox queue (not Outbox), so it can never be mistaken for
    # a send. Mirrors `mail send`'s move-then-write-intent handoff.
    if len(args) != 1:
        die(USAGE, "usage: mail draft <draft-path>")
    draft = resolve_in_room(args[0])
    address = account_of(draft)
    in_drafts = False
    if address:
        try:
            rel_parts = (
                draft.resolve()
                .relative_to((ROOM / "accounts" / address).resolve())
                .parts
            )
            in_drafts = (
                len(rel_parts) >= 2
                and rel_parts[0] == "mail"
                and rel_parts[1] == "Drafts"
            )
        except ValueError:
            pass
    if not in_drafts:
        die(
            POLICY_REFUSAL,
            f"refusing: draft only accepts drafts under accounts/<account>/mail/Drafts/ (got {args[0]!r})",
        )

    raw = draft.read_bytes()
    msg = parse_eml_bytes(raw)
    message_id = (msg.get("Message-ID") or "").strip()

    box = account_dir(address) / "mail" / "DraftBox"
    box_new = box / "new"
    box_tmp = box / "tmp"
    box_new.mkdir(parents=True, exist_ok=True)
    box_tmp.mkdir(parents=True, exist_ok=True)

    dest = box_new / draft.name
    intent = {
        "account": address,
        "op": "upload",
        "sha256_12": sha12(raw),
        "message_id": str(message_id),
        "ts": now_iso(),
    }
    draft.replace(dest)
    tmp_intent = box_tmp / (draft.name + ".draft.json")
    tmp_intent.write_text(json.dumps(intent, indent=2), encoding="utf-8")
    tmp_intent.replace(box_new / (draft.name + ".draft.json"))

    print(f"DRAFT queued: {rel(dest)}")
    status = read_status()
    if status is not None and status.get("dry_run") is not False:
        print(
            "NOTE: dry_run is on — the broker will SIMULATE this draft upload when "
            "the command ends (no provider-side draft is created)."
        )
    else:
        print(
            "NOTE: the broker uploads this into your provider Drafts when this "
            "command ends; the outcome (DRAFT UPLOADED / SIMULATED / REJECTED) "
            "rides in the tool result. It is never sent."
        )
    return OK


def cmd_draft_delete(args):
    # Reversibly remove a provider-side draft by its Message-ID. The broker
    # MOVES it to Trash / Deleted Items (recoverable); it never hard-deletes.
    if len(args) != 2:
        die(USAGE, "usage: mail draft-delete <account> <message-id>")
    address, message_id = args
    if not account_dir(address).is_dir():
        die(
            NOT_FOUND,
            f"no such account: {address} (known: {', '.join(known_accounts()) or 'none'})",
        )
    message_id = message_id.strip()
    if not message_id:
        die(USAGE, "mail draft-delete: message-id is empty")

    box = account_dir(address) / "mail" / "DraftBox"
    box_new = box / "new"
    box_tmp = box / "tmp"
    box_new.mkdir(parents=True, exist_ok=True)
    box_tmp.mkdir(parents=True, exist_ok=True)

    intent = {
        "account": address,
        "op": "delete",
        "message_id": message_id,
        "ts": now_iso(),
    }
    name = f"{int(time.time())}.{sha12(message_id)}.delete.draft.json"
    tmp_intent = box_tmp / name
    tmp_intent.write_text(json.dumps(intent, indent=2), encoding="utf-8")
    tmp_intent.replace(box_new / name)

    print(f"DRAFT-DELETE queued: {message_id}")
    status = read_status()
    if status is not None and status.get("dry_run") is not False:
        print(
            "NOTE: dry_run is on — the broker will SIMULATE this draft delete when "
            "the command ends (no provider-side change)."
        )
    else:
        print(
            "NOTE: the broker moves the provider draft to Trash / Deleted Items when "
            "this command ends (reversible); the outcome (DRAFT DELETED / SIMULATED / "
            "REJECTED) rides in the tool result. It never hard-deletes."
        )
    return OK


def cmd_status(args):
    if args:
        die(USAGE, "usage: mail status")
    status = read_status()
    if status is None:
        print("broker: NOT RUNNING (no status published yet)")
        print(
            "`messageoperator serve` runs the broker at tool-call boundaries; "
            "`messageoperator broker` is the standalone poll loop."
        )
        return OK
    age = broker_age_seconds(status)
    age_txt = f"{age:.0f}s ago" if age is not None else "unknown"
    if broker_mode(status) == "boundary":
        print(
            f"broker: BOUNDARY MODE (pull before / push after each tool call; last cycle {age_txt})"
        )
    elif broker_running(status):
        print(f"broker: RUNNING (last cycle {age_txt})")
    else:
        print(f"broker: STALE / likely stopped (last cycle {age_txt})")
    print(
        f"dry_run: {json.dumps(status.get('dry_run'))}"
        + (
            "  (sends are SIMULATED, not delivered)"
            if status.get("dry_run") is not False
            else "  (sends are DELIVERED)"
        )
    )
    own = status.get("own_addresses", [])
    allowed = status.get("allowed_recipient_domains", [])
    # Report CONNECTED mailboxes. status["accounts"] is the set of local
    # maildirs, which still contains a removed mailbox whose mail was kept —
    # printing that made `mail status` claim a removed account was live.
    live = status.get("connected_accounts")
    if not isinstance(live, list):
        live = status.get("accounts", [])  # older broker: no better signal
    print(f"accounts: {', '.join(live) or 'none'}")
    # Removing an account keeps its mail by default, and `mail index` reads the
    # store — so without this line status and index disagree about how many
    # mailboxes exist, and the extra ones look live.
    for address, count in retained_disconnected_counts(status):
        print(
            f"disconnected (removed, local archive only): {address} — "
            f"{count} message(s) still listed by `mail index`; "
            f"`mail login {address}` to reconnect"
        )
    print(f"own addresses (always allowed): {', '.join(own) or 'none'}")
    print(
        f"allowed recipient domains: {', '.join(allowed) or 'none (own addresses only)'}"
    )
    print(f"max sends/hour: {status.get('max_sends_per_hour')}")
    print(f"queued sends: {status.get('pending_intents', 0)}")
    if status.get("last_network_sync"):
        print(f"last inbound sync: {status['last_network_sync']}")
    auth = status.get("auth") or {}
    auth_urls = status.get("auth_urls") or {}
    for account in sorted(auth.keys()):
        state = auth[account]
        hint = ""
        if state == "needs_login":
            hint = (
                f"  (sign-in pending — have the user open: {auth_urls[account]} — or run `mail login` to reopen the browser)"
                if account in auth_urls
                else "  (run `mail login` to start the sign-in; the browser opens on the host)"
            )
        elif state in ("no_app_password", "bad_app_password"):
            hint = (
                f"  (setup page open — have the user finish it: {auth_urls[account]} — or run `mail login {account}` to reopen it)"
                if account in auth_urls
                else f"  (run `mail login {account}` — a guided page opens in the user's browser to create and store a Gmail app password; never ask for the password in chat)"
            )
        print(f"auth {account}: {state}{hint}")
    # backfill progress straight from the store: a fresh mailbox keeps
    # growing between commands until the history walk reports caught up
    conn = open_store()
    if conn is not None:
        try:
            rows = conn.execute(
                "SELECT account, mailbox, status, total_expected FROM sync_state"
            ).fetchall()
            in_progress = [r for r in rows if r["status"] == "in_progress"]
            if in_progress:
                for r in in_progress:
                    extra = (
                        f" (~{r['total_expected']} total on server)"
                        if r["total_expected"]
                        else ""
                    )
                    print(
                        f"backfill {r['account']} ({r['mailbox']}): in progress{extra}"
                    )
            elif rows:
                print("backfill: caught up (full mailbox indexed)")
        except sqlite3.Error:
            pass
        finally:
            conn.close()
    return OK


def cmd_account(args):
    if len(args) != 3 or args[0] != "add":
        die(USAGE, "usage: mail account add <gmail|microsoft> <address>")
    provider = args[1].lower()
    address = args[2].lower()
    if provider not in ("gmail", "microsoft"):
        die(USAGE, f"mail account: unknown provider '{args[1]}' (gmail or microsoft)")

    email_pattern = re.compile(
        r"^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9_%+-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$"
    )
    if ".." in address or not email_pattern.match(address):
        die(USAGE, f"mail account: {args[2]!r} does not look like an email address")

    append_jsonl(
        ACCOUNT_REQUEST_FILE,
        {"provider": provider, "address": address, "ts": now_iso()},
    )

    print(
        f"ACCOUNT requested: {provider} {address} — the broker registers it when this tool call ends."
    )
    if provider == "microsoft":
        print(
            "If the Microsoft client ID is set in the extension settings, a "
            "sign-in browser window opens on the host and the user completes "
            "it there. If `mail status` shows the account as `unconfigured`, "
            "ask the user to set the client ID in the extension settings — "
            "sign-in then starts automatically on the next mail activity."
        )
    else:
        print(
            "Gmail needs an app password (it never passes through this room): "
            f"run `mail login {address}` — a guided page opens in the user's "
            "browser to create and store it. `mail status` shows "
            "no_app_password until then."
        )
    return OK


def cmd_login(args):
    usage = "usage: mail login [address] [--provider gmail|microsoft] [--client-id ID]"
    address = ""
    provider = ""
    client_id = ""
    it = iter(args)
    for arg in it:
        if arg == "--provider":
            try:
                provider = next(it).lower()
            except StopIteration:
                die(USAGE, usage)
        elif arg == "--client-id":
            try:
                client_id = next(it)
            except StopIteration:
                die(USAGE, usage)
        elif not arg.startswith("--") and not address:
            address = arg.lower()
        else:
            die(USAGE, usage)

    if provider and provider not in ("gmail", "microsoft"):
        die(USAGE, "--provider must be gmail or microsoft")
    if (provider or client_id) and not address:
        die(USAGE, f"--provider/--client-id need an address: {usage}")

    request = {"address": address, "ts": now_iso()}
    if provider:
        request["provider"] = provider
    if client_id:
        request["client_id"] = client_id

    LOGIN_REQUEST_FILE.write_text(json.dumps(request, indent=2), encoding="utf-8")
    print(
        f"LOGIN requested{f' for {address}' if address else ''}: when this tool call ends, "
        "the broker starts the sign-in flow and opens a browser on the host "
        "(Gmail: a guided app-password setup page; Microsoft: the OAuth sign-in). "
        "Tell the user to finish the steps in that browser tab. "
        "Check `mail status` afterwards for the pending URL and auth state."
    )
    return OK


def resolve_tag_target(arg):
    """id-or-path resolution for tag/tags: returns (sha, display)."""
    if looks_like_path(arg):
        p = resolve_in_room(arg)
        if not p.is_file():
            die(NOT_FOUND, f"not a file: {arg}")
        return sha12(p.read_bytes()), rel(p)
    conn = open_store()
    record = get_by_sha(conn, arg) if conn else None
    if conn:
        conn.close()
    if record is None:
        die(NOT_FOUND, f"not found: {arg} (no such file or message id)")
    return record["sha"], record["sha"]


def cmd_tag(args):
    if len(args) != 2:
        die(USAGE, "usage: mail tag <id-or-path> <tag>")
    sha, display = resolve_tag_target(args[0])
    append_jsonl(
        TAGS_FILE, {"sha": sha, "path": display, "tag": args[1], "ts": now_iso()}
    )
    print(f"tagged {display} with {args[1]!r} (broker folds tags into the index)")
    return OK


def cmd_untag(args):
    if len(args) != 2:
        die(USAGE, "usage: mail untag <id-or-path> <tag>")
    sha, display = resolve_tag_target(args[0])
    append_jsonl(
        UNTAG_FILE, {"sha": sha, "path": display, "tag": args[1], "ts": now_iso()}
    )
    print(f"untagged {display} from {args[1]!r} (broker folds tags into the index)")
    return OK


def _tag_event_time(ts):
    """Epoch seconds for a tag/untag timestamp. ISO-8601 with mixed 'Z' and
    '+00:00' offsets does NOT sort lexicographically, so parse it. Unparsable
    or missing timestamps count as oldest and keep their file order."""
    raw = str(ts or "").strip()
    if raw:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return float("-inf")


def cmd_tags(args):
    if len(args) != 1:
        die(USAGE, "usage: mail tags <id-or-path>")
    sha, _display = resolve_tag_target(args[0])
    tags = set()
    conn = open_store()
    if conn is not None:
        try:
            for row in conn.execute("SELECT tag FROM tag WHERE sha=?", (sha,)):
                tags.add(row["tag"])
        except sqlite3.Error:
            pass
        finally:
            conn.close()
    events = []
    seq = 0
    if TAGS_FILE.exists():
        try:
            for line in TAGS_FILE.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                entry = json.loads(line)
                if entry.get("sha") == sha and entry.get("tag"):
                    seq += 1
                    events.append((_tag_event_time(entry.get("ts")), seq, "tag", entry.get("tag")))
        except Exception:
            pass
    if UNTAG_FILE.exists():
        try:
            for line in UNTAG_FILE.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                entry = json.loads(line)
                if entry.get("sha") == sha and entry.get("tag"):
                    seq += 1
                    events.append((_tag_event_time(entry.get("ts")), seq, "untag", entry.get("tag")))
        except Exception:
            pass
    events.sort(key=lambda x: (x[0], x[1]))
    for _ts, _seq, op, tag in events:
        if op == "tag":
            tags.add(tag)
        elif op == "untag":
            tags.discard(tag)
    for tag in sorted(tags):
        print(tag)
    return OK


def folder_of(p):
    """accounts/<addr>/mail/<Folder>/... -> Folder, or None."""
    parts = rel(p).split("/")
    if len(parts) >= 5 and parts[0] == "accounts" and parts[2] == "mail":
        return parts[3]
    return None


def noop_notice(op, ident):
    """
    Why this is loud: a no-op means NOTHING was sent to the provider, but it
    exits 0 with no outcome chip, so it reads as success. Agents have reported
    "archived" to users on the strength of it, and rationalised the surprise
    ("a filter must have moved it"). If the room ever drifts from the mailbox,
    this line is the only place the truth surfaces — so it also names the fix.
    """
    state = "archived" if op == "archive" else "in inbox"
    inverse = "unarchive" if op == "archive" else "archive"
    return (
        f"already {state} (no-op): {ident} — NOT sent to the provider; the room "
        f"already has it {state}, so there was nothing to apply. If the mailbox "
        f"disagrees, the room has drifted: with dry run off, run "
        f"`mail {inverse} {ident}` then `mail {op} {ident}`."
    )


def queue_folder_change(args, op):
    if not args:
        die(USAGE, f"usage: mail {op} <id-or-path> [...]")
    source, already = ("INBOX", "Archive") if op == "archive" else ("Archive", "INBOX")
    queued, failures = [], 0
    conn = open_store()
    try:
        for arg in args:
            request = None
            if looks_like_path(arg):
                try:
                    p = resolve_in_room(arg)
                except SystemExit:
                    failures += 1  # resolve_in_room already printed the reason
                    continue
                address = account_of(p)
                folder = folder_of(p)
                if (
                    not address
                    or folder is None
                    or not p.is_file()
                    or p.suffix != ".eml"
                ):
                    print(
                        f"error: {arg}: not a message file under accounts/<address>/mail/",
                        file=sys.stderr,
                    )
                    failures += 1
                    continue
                if folder == already:
                    print(noop_notice(op, rel(p)))
                    continue
                if folder != source and folder != ".Cache":
                    print(
                        f"error: {arg}: can only {op} messages in {source}/ (got {folder}/)",
                        file=sys.stderr,
                    )
                    failures += 1
                    continue
                raw = p.read_bytes()
                msg = parse_eml_bytes(raw)
                message_id = (msg.get("Message-ID") or "").strip()
                if not message_id:
                    print(
                        f"error: {arg}: message has no Message-ID header; cannot {op} it provider-side",
                        file=sys.stderr,
                    )
                    failures += 1
                    continue
                request = {
                    "op": op,
                    "account": address,
                    "path": rel(p),
                    "sha": sha12(raw),
                    "message_id": str(message_id),
                    "ts": now_iso(),
                }
            else:
                record = get_by_sha(conn, arg) if conn else None
                if record is None:
                    print(f"error: {arg}: no such file or message id", file=sys.stderr)
                    failures += 1
                    continue
                if record["folder"] == already:
                    print(noop_notice(op, record["sha"]))
                    continue
                if not record["rfc_message_id"]:
                    print(
                        f"error: {arg}: the index has no Message-ID for it; run 'mail fetch {record['sha']}' first",
                        file=sys.stderr,
                    )
                    failures += 1
                    continue
                request = {
                    "op": op,
                    "account": record["account"],
                    "path": record["path"],
                    "sha": record["sha"],
                    "message_id": record["rfc_message_id"],
                    "ts": now_iso(),
                }
            append_jsonl(FOLDER_REQUEST_FILE, request)
            print(f"{op.upper()} queued: {request['path'] or request['sha']}")
            queued.append(request)
    finally:
        if conn is not None:
            conn.close()
    if queued:
        status = read_status()
        if status is not None and status.get("dry_run") is not False:
            print(
                f"NOTE: dry_run is on — the broker will SIMULATE this {op} when the "
                "command ends: NOTHING changes, provider-side or locally, so the "
                f"room keeps matching the mailbox. The message is NOT {op}d. Turn "
                "dry run off via `mail settings` to apply it for real."
            )
        else:
            print(
                f"NOTE: the broker applies this {op} provider-side when this command "
                "ends; the authoritative outcome appears in the tool result "
                "(ARCHIVED / SIMULATED / REJECTED). Never deletes anything."
            )
    return USAGE if failures else OK


def cmd_pack(args):
    if len(args) != 1:
        die(USAGE, "usage: mail pack <path-to-docx-md-view>")
    p = resolve_in_room(args[0])
    if not p.is_file():
        die(NOT_FOUND, f"not a file: {args[0]}")
    r = rel(p)
    if not r.startswith("attachments/"):
        die(
            POLICY_REFUSAL,
            "refusing: pack only works on Markdown views under attachments/",
        )
    name = p.name.lower()
    if name.endswith(".pdf.md"):
        die(
            POLICY_REFUSAL,
            "refusing: PDF views are read-only; only .docx.md views can be packed",
        )
    if not name.endswith(".docx.md"):
        die(
            POLICY_REFUSAL,
            f"refusing: pack needs a .docx.md Markdown view (got {args[0]!r})",
        )
    source = p.with_name(p.name[:-3])
    if not source.is_file():
        die(NOT_FOUND, f"no source document beside the view: {rel(source)} is missing")
    append_jsonl(PACK_REQUEST_FILE, {"path": r, "ts": now_iso()})
    print(f"PACK queued: {r}")
    print(
        "NOTE: when this command ends, the broker rebases your Markdown "
        f"edits into {rel(source)} as Word tracked changes (author "
        '"AI Agent") and refreshes the view to show them as CriticMarkup '
        "({++insertions++} / {--deletions--}). The authoritative outcome "
        "(PACKED / PACK REJECTED) rides in the tool result. Send the "
        f"binary with: mail send <draft> --attach {rel(source)}"
    )
    return OK


def cmd_settings(args):
    if args:
        die(USAGE, "usage: mail settings")
    SETTINGS_REQUEST_FILE.write_text(json.dumps({"ts": now_iso()}), encoding="utf-8")
    print(
        "SETTINGS page requested: when this tool call ends, the broker opens "
        "the Message Operator settings page in the user's browser (dry run, allowed "
        "recipient domains, mailbox removal). Only the user can change "
        "anything there. Tell the user to look at their browser."
    )
    return OK


def cmd_import(args):
    """Copy a file from OUTSIDE the room INTO the room's attachments/ so it can
    be attached to an email. The source may be a Cowork sandbox path OR an
    ordinary folder on the user's machine — the room runs on that machine, so
    both are reachable; only a separate cloud sandbox is not. Reads from outside
    the room (a specific file the user pointed at); only ever writes inside
    attachments/."""
    if len(args) != 1:
        die(USAGE, "usage: mail import <absolute-path>")
    raw = Path(str(args[0]))
    # Check VM-path shape BEFORE the is_absolute() guard: a sandbox path like
    # "/mnt/user-data/..." is not drive-qualified, so Windows-native Python
    # reports is_absolute()==False and would emit a misleading "give an
    # absolute path" (the path IS absolute — for another machine). The honest
    # answer is that the bridge cannot reach that machine at all.
    if looks_like_sandbox_vm_path(args[0], raw):
        die(POLICY_REFUSAL, BRIDGE_UNAVAILABLE_MSG)
    if not raw.is_absolute():
        die(
            USAGE,
            "mail import: give the ABSOLUTE path of the file — either in your "
            "sandbox (the outputs/ path you just wrote) or on the user's own "
            "machine (e.g. their Downloads folder)",
        )
    src = raw.resolve()
    if not src.is_file():
        die(NOT_FOUND, f"not a file: {args[0]}")
    # never let import be used to pull arbitrary room-internal files around;
    # its purpose is bringing OUTSIDE files in. Files already in the room are
    # attachable directly.
    room = ROOM.resolve()
    if norm(src) == norm(room) or norm(src).startswith(norm(room) + os.sep):
        die(
            POLICY_REFUSAL,
            "refusing: that path is already inside the room; attach it directly",
        )
    dest_dir = ROOM / "attachments" / "imported"
    dest_dir.mkdir(parents=True, exist_ok=True)
    name = sanitize_attachment_name(src.name)
    dest = dest_dir / name
    # dedup on name collision with different content
    n = 1
    while dest.exists():
        try:
            if dest.read_bytes() == src.read_bytes():
                break  # identical: reuse it
        except OSError:
            pass
        dot = name.rfind(".")
        stem, ext = (name[:dot], name[dot:]) if dot > 0 else (name, "")
        dest = dest_dir / f"{stem}({n}){ext}"
        n += 1
    if not (dest.exists() and dest.read_bytes() == src.read_bytes()):
        import shutil

        shutil.copyfile(src, dest)
    print(rel(dest))
    print(
        f"IMPORTED into the room: {rel(dest)} — attach it with "
        f"`mail send <draft> --attach {rel(dest)}`"
    )
    return OK


def cmd_export(args):
    """Copy a room file (a received attachment, by message id or by
    attachments/<sha>/<file> path) OUT to the Cowork sandbox so skills can open
    it. This is the ONLY command that writes outside the room jail, and only
    into a sandbox outputs/uploads mount."""
    if len(args) < 3 or "--to" not in args:
        die(
            USAGE,
            "usage: mail export <id-or-attachment-path> --to <sandbox-dir> [--name <file>]",
        )
    to_idx = args.index("--to")
    dest_dir_arg = args[to_idx + 1] if to_idx + 1 < len(args) else None
    if not dest_dir_arg:
        die(USAGE, "mail export: --to needs a sandbox directory")
    only_name = None
    if "--name" in args:
        ni = args.index("--name")
        only_name = args[ni + 1] if ni + 1 < len(args) else None
    source = args[0]

    # 1. resolve the source to one or more in-room attachment files
    files = []
    if looks_like_path(source):
        p = resolve_in_room(source)  # jail-checked; must be inside the room
        if not p.is_file():
            die(NOT_FOUND, f"not a file: {source}")
        files = [p]
    else:
        conn = open_store()
        record = get_by_sha(conn, source) if conn else None
        if conn:
            conn.close()
        if record is None:
            die(NOT_FOUND, f"not found: {source} (no such file or message id)")
        att_dir = ROOM / "attachments" / record["sha"]
        # attachments are stored under attachments/<content-sha>/; the message
        # sha and content sha differ, so discover the dir from the .meta sidecar
        if record["path"]:
            meta = ROOM / PurePosixPath(record["path"] + ".meta")
            if meta.exists():
                for line in meta.read_text(
                    encoding="utf-8", errors="replace"
                ).splitlines():
                    if line.startswith("X-Messageoperator-Attachments:") or line.startswith("X-Mailroom-Attachments:"):
                        rp = line.split(":", 1)[1].strip()
                        fp = ROOM / PurePosixPath(rp)
                        if fp.is_file():
                            files.append(fp)
        if not files and att_dir.is_dir():
            files = [
                f
                for f in sorted(att_dir.iterdir())
                if f.is_file() and not f.name.endswith(".md")
            ]
        if not files:
            die(
                NOT_FOUND,
                f"{source} has no extracted attachments on disk "
                f"(run 'mail fetch {source}' first if its body is not downloaded)",
            )
    if only_name:
        files = [f for f in files if f.name == only_name]
        if not files:
            die(NOT_FOUND, f"no attachment named {only_name!r} on that message")

    # 2. validate the destination is a real sandbox mount (jail escape hatch)
    # A VM-shaped destination (plain chat) is unreachable no matter what path
    # is passed — say so honestly rather than "pass the outputs path your
    # sandbox reports" (there is none) or silently copying to a dead host dir.
    if looks_like_sandbox_vm_path(dest_dir_arg, Path(dest_dir_arg).resolve()):
        die(POLICY_REFUSAL, BRIDGE_UNAVAILABLE_MSG)
    if not is_allowed_export_dir(dest_dir_arg):
        die(
            POLICY_REFUSAL,
            "refusing: export can only write into a Cowork sandbox outputs/uploads "
            f"folder (got {dest_dir_arg!r}); pass the outputs path your sandbox reports",
        )
    dest_dir = Path(dest_dir_arg)
    if not dest_dir.is_dir():
        die(NOT_FOUND, f"destination directory does not exist: {dest_dir_arg}")

    # 3. copy out
    import shutil

    exported = []
    for f in files:
        out = dest_dir / sanitize_attachment_name(f.name)
        shutil.copyfile(f, out)
        exported.append(str(out))
        print(f"EXPORTED: {rel(f)} -> {out}")
    print(
        f"{len(exported)} file(s) exported to the sandbox; open them there "
        "(e.g. with the xlsx/pdf skills)."
    )
    return OK


def cmd_archive(args):
    return queue_folder_change(args, "archive")


def cmd_unarchive(args):
    return queue_folder_change(args, "unarchive")


# ---- mail table (tabular attachment reader) --------------------------
# Reads the .tabular.db sidecar the broker wrote at sync time (read-only,
# stdlib sqlite3). All transforms — slice, project, format, values-vs-formulas
# — are reshapings of already-parsed data, so they run here synchronously with
# no broker round-trip and no re-parsing of the binary.


def parse_flags(args):
    """Split argv into positionals (_) and --flags. A flag with no value (its
    successor is another --flag, or it is last) becomes True; otherwise it
    takes the next token as its value. A leading '-' that is not '--' (e.g. a
    negative number like -1) is treated as a value, not a flag."""
    out = {"_": []}
    i = 0
    n = len(args)
    while i < n:
        a = args[i]
        if a.startswith("--"):
            key = a[2:]
            nxt = args[i + 1] if i + 1 < n else None
            if nxt is None or nxt.startswith("--"):
                out[key] = True
            else:
                out[key] = nxt
                i += 1
        else:
            out["_"].append(a)
        i += 1
    return out


def _tabular_dbs_from_meta(meta_path):
    out = []
    if meta_path.is_file():
        try:
            for line in meta_path.read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith("X-Messageoperator-Attachment-Tables:") or line.startswith("X-Mailroom-Attachment-Tables:"):
                    rel = line.split(":", 1)[1].strip()
                    # the attachment is the db path minus the .tabular.db suffix
                    name = (
                        rel[: -len(".tabular.db")]
                        if rel.endswith(".tabular.db")
                        else rel
                    )
                    out.append((PurePosixPath(name).name, rel))
        except OSError:
            pass
    return out


def _tabular_dbs_for_message(sha):
    """Resolve a message id to its .tabular.db sidecar paths (room-relative).

    Reads the message's .meta sidecar for X-Mailroom-Attachment-Tables lines.
    Returns a list of (attachment_name, room_relative_db_path). Empty when the
    message has no tabular attachments or its body is not on disk yet."""
    conn = open_store()
    record = get_by_sha(conn, sha) if conn else None
    if conn:
        conn.close()
    if record is None:
        die(NOT_FOUND, f"not found: {sha} (no such message id)")
    if not record["path"]:
        die(
            NOT_FOUND,
            f"{sha}: body not on disk — run 'mail fetch {sha}' first, then "
            "'mail table' in your next command",
        )
    meta = ROOM / PurePosixPath(record["path"] + ".meta")
    return _tabular_dbs_from_meta(meta)


def _tabular_dbs_for_path(arg):
    """Resolve a room-relative/absolute path to its .tabular.db sidecar.

    Accepts an .eml message file, its .meta sidecar, the attachment itself (data.xlsx),
    the sidecar (data.xlsx.tabular.db), or the markdown view (data.xlsx.md).
    Returns [(attachment_name, rel_db)] or []. No store/message-id needed —
    this is the id-or-path escape hatch the other verbs also offer."""
    p = resolve_in_room(arg)  # jail-checked; dies if outside the room
    s = p.as_posix()

    if s.endswith(".eml"):
        meta = p.with_name(p.name + ".meta")
        dbs = _tabular_dbs_from_meta(meta)
        if dbs:
            return dbs
    elif s.endswith(".meta"):
        dbs = _tabular_dbs_from_meta(p)
        if dbs:
            return dbs

    if s.endswith(".tabular.db"):
        db = p
        att_name = PurePosixPath(s[: -len(".tabular.db")]).name
    elif s.endswith(".md"):
        db = Path(s[: -len(".md")] + ".tabular.db")
        att_name = PurePosixPath(s[: -len(".md")]).name
    else:
        db = Path(s + ".tabular.db")
        att_name = p.name

    if not db.is_file():
        if s.endswith(".eml") or s.endswith(".meta"):
            return []
        die(
            NOT_FOUND,
            f"no tabular sidecar for {arg} (expected {rel(db)}); "
            "is it a spreadsheet/CSV attachment that synced?",
        )
    return [(att_name, rel(db))]


def _open_sidecar(rel_db_path):
    """Open a .tabular.db read-only, verifying its schema version."""
    p = resolve_in_room(rel_db_path)
    if not p.is_file():
        die(NOT_FOUND, f"tabular sidecar missing: {rel_db_path}")
    try:
        uri = p.resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=1.0)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error as exc:
        die(NOT_FOUND, f"cannot open tabular sidecar {rel_db_path}: {exc}")
    try:
        row = conn.execute(
            "SELECT value FROM meta WHERE key='schema_version'"
        ).fetchone()
    except sqlite3.Error:
        conn.close()
        die(NOT_FOUND, f"{rel_db_path} is not a valid tabular sidecar")
    version = int(row["value"]) if row and str(row["value"]).isdigit() else 0
    if version != SIDECAR_SCHEMA_VERSION:
        conn.close()
        die(
            NOT_FOUND,
            f"{rel_db_path} sidecar schema v{version} != expected "
            f"v{SIDECAR_SCHEMA_VERSION}; re-fetch the message to rebuild it",
        )
    return conn


def _resolve_sheet(conn, sheet_arg):
    """Resolve a --sheet argument (name or 0-based index) to a sheet row."""
    rows = conn.execute(
        "SELECT sheet_index, name, n_rows, n_cols, header_row "
        "FROM sheets ORDER BY sheet_index"
    ).fetchall()
    if not rows:
        die(NOT_FOUND, "sidecar has no sheets")
    # exact name match first
    for r in rows:
        if r["name"] == sheet_arg:
            return r
    # then 0-based index
    if str(sheet_arg).lstrip("-").isdigit():
        idx = int(sheet_arg)
        for r in rows:
            if r["sheet_index"] == idx:
                return r
    names = ", ".join(f"{r['sheet_index']}:{r['name']}" for r in rows)
    die(NOT_FOUND, f"no sheet {sheet_arg!r} (available: {names})")


def _sheet_columns(conn, sheet_index):
    return conn.execute(
        "SELECT col_index, header, native_type FROM columns "
        "WHERE sheet_index=? ORDER BY col_index",
        (sheet_index,),
    ).fetchall()


def _assemble_rows(conn, sheet_index, n_cols, which, row_lo, row_hi):
    """Assemble dense rows [row_lo, row_hi) from the tall cells table.

    `which` selects the source column: 'value', 'value_raw', or 'formula'.
    Returns a dict {row_index: [cell, ...]} with gaps filled as None. The
    caller decides how header/data rows map onto row_index."""
    q = (
        f"SELECT row_index, col_index, {which} AS cell FROM cells "
        "WHERE sheet_index=? AND row_index>=? AND row_index<? "
        "ORDER BY row_index, col_index"
    )
    grid = {}
    for r in conn.execute(q, (sheet_index, row_lo, row_hi)):
        ri = r["row_index"]
        if ri not in grid:
            grid[ri] = [None] * n_cols
        ci = r["col_index"]
        if 0 <= ci < n_cols:
            grid[ri][ci] = r["cell"]
    return grid


def _parse_rows_flag(rows_flag, total):
    """Parse --rows A:B (0-based half-open) into (lo, hi) clamped to total."""
    if rows_flag is None:
        return 0, total
    m = re.match(r"^(\d*):(\d*)$", str(rows_flag))
    if not m:
        die(USAGE, f"--rows must be A:B (0-based half-open), got {rows_flag!r}")
    lo = int(m.group(1)) if m.group(1) else 0
    hi = int(m.group(2)) if m.group(2) else total
    lo = max(0, min(lo, total))
    hi = max(lo, min(hi, total))
    return lo, hi


def _select_cols(columns, cols_flag):
    """Resolve --cols (names or indices) to an ordered list of col rows.

    Returns all columns when cols_flag is None."""
    if cols_flag is None:
        return list(columns)
    by_name = {c["header"]: c for c in columns if c["header"] is not None}
    by_index = {c["col_index"]: c for c in columns}
    chosen = []
    for token in str(cols_flag).split(","):
        t = token.strip()
        if not t:
            continue
        if t in by_name:
            chosen.append(by_name[t])
        elif t.isdigit() and int(t) in by_index:
            chosen.append(by_index[int(t)])
        else:
            die(NOT_FOUND, f"no column {t!r} in this sheet")
    if not chosen:
        die(USAGE, "--cols selected no columns")
    return chosen


def cmd_table(args):
    flags = parse_flags(args)
    if not flags["_"]:
        die(USAGE, "usage: mail table <id-or-path> [--sheet S] [options]")
    target = flags["_"][0]

    if looks_like_path(target):
        dbs = _tabular_dbs_for_path(target)
    else:
        dbs = _tabular_dbs_for_message(target)
    if not dbs:
        die(
            NOT_FOUND,
            f"{target}: no tabular attachments (spreadsheet/CSV) found",
        )

    # pick the attachment: --attachment NAME, else the sole one, else list
    attachment = flags.get("attachment")
    if attachment is True:
        die(USAGE, "--attachment needs an attachment name")
    if attachment:
        match = [d for d in dbs if d[0] == attachment]
        if not match:
            names = ", ".join(d[0] for d in dbs)
            die(NOT_FOUND, f"no tabular attachment {attachment!r} (have: {names})")
        chosen = match[0]
    elif len(dbs) == 1:
        chosen = dbs[0]
    else:
        print(
            f"{len(dbs)} tabular attachments on {target}; pick one with --attachment:"
        )
        for name, _rel in dbs:
            print(f"  {name}")
        return OK

    conn = _open_sidecar(chosen[1])
    try:
        sheet_arg = flags.get("sheet")
        if sheet_arg is None or sheet_arg is True:
            if sheet_arg is True:
                die(USAGE, "--sheet needs a sheet name or index")
            return _list_sheets(conn, chosen[0])
        return _print_sheet(conn, chosen[0], sheet_arg, flags)
    finally:
        conn.close()


def _data_row_count(n_rows, header_row):
    """Rows of actual data: the stored grid minus the header row. sheets.n_rows
    is a GRID count (cell row_index is relative to it), but every count the verb
    prints or slices is a DATA count — --rows A:B, --format records/jsonl, the
    truncation marker. The listing used to print the grid count, so an agent
    reading it sliced one row short."""
    start = 0 if header_row is None else header_row + 1
    return max(0, n_rows - start)


def _list_sheets(conn, attachment_name):
    sheets = conn.execute(
        "SELECT sheet_index, name, n_rows, n_cols, header_row "
        "FROM sheets ORDER BY sheet_index"
    ).fetchall()
    print(f"{attachment_name}: {len(sheets)} sheet(s)")
    for s in sheets:
        cols = _sheet_columns(conn, s["sheet_index"])
        schema = ", ".join(
            f"{c['header'] or ('col' + str(c['col_index']))}:{c['native_type']}"
            for c in cols
        )
        hdr = "none" if s["header_row"] is None else str(s["header_row"])
        rows = _data_row_count(s["n_rows"], s["header_row"])
        print(
            f"  [{s['sheet_index']}] {s['name']}  "
            f"{rows} rows × {s['n_cols']} cols  header_row={hdr}"
        )
        if schema:
            print(f"        schema: {schema}")
    return OK


def _print_sheet(conn, attachment_name, sheet_arg, flags):
    sheet = _resolve_sheet(conn, sheet_arg)
    sheet_index = sheet["sheet_index"]
    n_cols = sheet["n_cols"]
    n_rows = sheet["n_rows"]

    # header row: --header-row overrides the stored guess; -1 => no header
    if flags.get("header-row") is not None and flags.get("header-row") is not True:
        try:
            header_row = int(flags["header-row"])
        except ValueError:
            die(USAGE, "--header-row needs an integer (use -1 for none)")
        if header_row < 0:
            header_row = None
    else:
        header_row = sheet["header_row"]

    columns = _select_cols(_sheet_columns(conn, sheet_index), flags.get("cols"))
    col_indices = [c["col_index"] for c in columns]

    use_formulas = flags.get("formulas") is True
    which = (
        "formula"
        if use_formulas
        else (
            "value"
            if (flags.get("formatted") is True or flags.get("format", "md") == "md")
            else "value_raw"
        )
    )

    # data rows are everything after the header row (or all rows if no header).
    # header_row here may be a --header-row override, so this recomputes rather
    # than reusing the listing's count.
    data_start = (header_row + 1) if header_row is not None else 0
    total_data = _data_row_count(n_rows, header_row)
    lo, hi = _parse_rows_flag(flags.get("rows"), total_data)

    # header labels for the chosen columns. With no header row (either the
    # sheet had none, or --header-row -1 overrode the guess), use synthetic
    # colN labels: the stored column headers were DERIVED from a header row
    # the caller just told us to ignore, so leaking them back in would
    # contradict the override.
    header_labels = []
    if header_row is not None:
        hgrid = _assemble_rows(
            conn, sheet_index, n_cols, "value", header_row, header_row + 1
        )
        hrow = hgrid.get(header_row, [None] * n_cols)
        for c in columns:
            v = hrow[c["col_index"]] if c["col_index"] < n_cols else None
            header_labels.append(v if v is not None else f"col{c['col_index']}")
    else:
        header_labels = [f"col{c['col_index']}" for c in columns]

    # assemble the requested data slice
    grid = _assemble_rows(
        conn, sheet_index, n_cols, which, data_start + lo, data_start + hi
    )
    ordered = [
        [grid.get(data_start + lo + k, [None] * n_cols)[ci] for ci in col_indices]
        for k in range(hi - lo)
    ]

    fmt = flags.get("format", "md")
    if fmt is True:
        die(USAGE, "--format needs a value (md|records|jsonl|csv|tsv)")
    note = ""
    if (lo, hi) != (0, total_data):
        note = f"  [rows {lo}:{hi} of {total_data} data rows]"
    if use_formulas:
        note += "  [formulas]"

    # coerce to native JSON/scalar types only for the machine formats reading
    # raw values (not --formatted display text, not --formulas strings); that
    # is exactly the `which == "value_raw"` case
    col_types = [c["native_type"] for c in columns] if which == "value_raw" else None

    if fmt == "md":
        _emit_md(
            attachment_name, sheet, header_labels, ordered, total_data, lo, hi, note
        )
    elif fmt == "records":
        _emit_records(header_labels, ordered, col_types)
    elif fmt == "jsonl":
        _emit_jsonl(header_labels, ordered, col_types)
    elif fmt in ("csv", "tsv"):
        _emit_dsv(header_labels, ordered, "\t" if fmt == "tsv" else ",", col_types)
    else:
        die(USAGE, f"unknown --format {fmt!r} (md|records|jsonl|csv|tsv)")
    return OK


def _emit_md(attachment_name, sheet, header_labels, rows, total_data, lo, hi, note):
    print(
        f"# {attachment_name} — sheet {sheet['name']!r}"
        f" ({sheet['n_rows']} rows × {sheet['n_cols']} cols){note}"
    )
    print()
    esc = lambda v: ("" if v is None else str(v).replace("|", "\\|").replace("\n", " "))
    print("| " + " | ".join(esc(h) for h in header_labels) + " |")
    print("| " + " | ".join("---" for _ in header_labels) + " |")
    for r in rows:
        print("| " + " | ".join(esc(v) for v in r) + " |")
    shown = hi - lo
    if shown < total_data:
        print()
        print(
            f"_showing {shown} of {total_data} data rows. "
            f"Use --rows A:B for another slice._"
        )
    return OK


def _coerce_cell(value, native_type):
    """Turn a stored-as-TEXT cell into its native JSON type for machine formats.

    SKILL.md promises the machine formats emit "numbers as numbers". The sidecar
    stores everything as text, so records/jsonl/csv/tsv coerce here using the
    column's native SheetJS type. Guarded: a value that does not actually parse
    as the claimed type (e.g. a stray text cell in a numeric column) is left as
    the original string. Dates ('d'), errors ('e'), and text ('s') stay strings —
    JSON has no date type and the stored value is already the right text.
    """
    if value is None:
        return None
    if native_type == "n":
        try:
            f = float(value)
            i = int(f)
            return i if f == i else f
        except (TypeError, ValueError):
            return value
    if native_type == "b":
        s = str(value).strip().lower()
        if s in ("true", "1", "yes"):
            return True
        if s in ("false", "0", "no"):
            return False
        return value
    return value


def _coerce_rows(rows, col_types):
    """Apply _coerce_cell across a row grid using per-column native types."""
    if col_types is None:
        return rows
    return [[_coerce_cell(v, col_types[i]) for i, v in enumerate(r)] for r in rows]


def _emit_records(header_labels, rows, col_types=None):
    rows = _coerce_rows(rows, col_types)
    out = []
    for r in rows:
        out.append({header_labels[i]: r[i] for i in range(len(header_labels))})
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return OK


def _emit_jsonl(header_labels, rows, col_types=None):
    rows = _coerce_rows(rows, col_types)
    for r in rows:
        obj = {header_labels[i]: r[i] for i in range(len(header_labels))}
        print(json.dumps(obj, ensure_ascii=False))
    return OK


def _emit_dsv(header_labels, rows, sep, col_types=None):
    import csv
    import io

    rows = _coerce_rows(rows, col_types)
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=sep, lineterminator="\n")
    writer.writerow(header_labels)
    for r in rows:
        writer.writerow(["" if v is None else v for v in r])
    sys.stdout.write(buf.getvalue())
    return OK


VERBS = {
    "index": cmd_index,
    "read": cmd_read,
    "search": cmd_search,
    "fetch": cmd_fetch,
    "reply": cmd_reply,
    "compose": cmd_compose,
    "send": cmd_send,
    "draft": cmd_draft,
    "draft-delete": cmd_draft_delete,
    "status": cmd_status,
    "account": cmd_account,
    "login": cmd_login,
    "settings": cmd_settings,
    "archive": cmd_archive,
    "unarchive": cmd_unarchive,
    "pack": cmd_pack,
    "import": cmd_import,
    "export": cmd_export,
    "tag": cmd_tag,
    "untag": cmd_untag,
    "tags": cmd_tags,
    "table": cmd_table,
}


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(USAGE_TEXT, end="")
        return OK if argv else USAGE
    verb = argv[0]
    handler = VERBS.get(verb)
    if handler is None:
        print(f"mail: unknown verb {verb!r}\n\n{USAGE_TEXT}", file=sys.stderr, end="")
        return USAGE
    try:
        return handler(argv[1:])
    except ValueError as exc:
        die(USAGE, f"mail {verb}: {exc}")
    except OSError as exc:
        die(USAGE, f"mail {verb}: file busy or unreadable ({exc}); retry shortly")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
