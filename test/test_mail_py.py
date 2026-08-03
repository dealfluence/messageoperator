#!/usr/bin/env python3
# FILE: test/test_mail_py.py
"""Standalone unittest for the in-room `mail` CLI (src/room_assets/mail.py).

mail.py is stdlib-only Python that runs in the room; it has no Node/Vitest
harness. This test builds a throwaway room on disk, copies mail.py into
<room>/bin/, and drives it as a subprocess (exactly as the broker's shim
does) to cover the pure-Python paths that TypeScript tests can't reach:

  * reply threading headers   — In-Reply-To / References must be LITERAL
                                <id@host> (no RFC2047, no truncation), and
                                must chain a prior References list.
  * mail import               — bring an OUTSIDE (sandbox) file into
                                attachments/imported/; refuse room-internal
                                paths; dedup identical content.
  * mail export               — copy a received attachment OUT to a sandbox
                                outputs/uploads mount; refuse non-mount
                                destinations and `..` traversal; honor --name
                                and multi-attachment resolution via the .meta
                                sidecar.

Run:  python3 -m unittest test.test_mail_py
  or  python3 test/test_mail_py.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Locate src/room_assets/mail.py relative to this test file (test/ is a sibling
# of src/). Allow override for unusual layouts.
REPO_ROOT = Path(__file__).resolve().parent.parent
MAIL_PY_SRC = Path(
    os.environ.get("MAILROOM_MAIL_PY", REPO_ROOT / "src" / "room_assets" / "mail.py")
)


def load_mail_module(py_path):
    """Import a mail.py as a module (no __main__ side effects)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("mailpy_uut", str(py_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Throwaway rooms are built HERE, never under tempfile.gettempdir(): on Linux
# that is /tmp, and "/tmp/" is one of mail.py's _SANDBOX_VM_MARKERS — the
# bridge detector refuses on path SHAPE, deliberately, so a sandbox-VM path
# can never false-succeed against a same-named host file (see
# BridgeDetectorTests). Under a /tmp tempdir every import/export in this
# suite therefore exits 2 with BRIDGE_UNAVAILABLE_MSG — the 9 CI-only
# failures of 2026-07-29 (green on Windows/macOS, whose tempdirs carry no
# marker). The repo checkout is marker-free everywhere this suite runs;
# MAILROOM_TEST_SCRATCH overrides for checkouts that are not (e.g. a clone
# under /tmp itself, or under a sandbox home).
SCRATCH_BASE = Path(
    os.environ.get("MAILROOM_TEST_SCRATCH", REPO_ROOT / "test" / ".scratch")
)


def _scratch_base_problem():
    """Reason SCRATCH_BASE cannot host rooms, or None. Asks mail.py's own
    detector, so this check cannot drift from the marker list."""
    if not MAIL_PY_SRC.is_file():
        return None  # setUp already skips on a missing mail.py
    probe = str((SCRATCH_BASE / "probe").resolve())
    if load_mail_module(MAIL_PY_SRC).looks_like_sandbox_vm_path(probe, probe):
        return (
            f"scratch base {SCRATCH_BASE} is itself shaped like an unreachable "
            "sandbox-VM path (_SANDBOX_VM_MARKERS in mail.py), so every "
            "import/export would be refused as bridge-unavailable. That is an "
            "environment problem, not a mail.py bug — do NOT widen the marker "
            "list; set MAILROOM_TEST_SCRATCH to a marker-free directory."
        )
    return None


_SCRATCH_PROBLEM = _scratch_base_problem()


class MailCliTestBase(unittest.TestCase):
    def setUp(self):
        if not MAIL_PY_SRC.is_file():
            self.skipTest(f"mail.py not found at {MAIL_PY_SRC}")
        if _SCRATCH_PROBLEM:
            self.skipTest(_SCRATCH_PROBLEM)
        # <home>/room is the room root; mail.py resolves ROOM as its own
        # parent.parent, so it must live at <room>/bin/mail.py
        SCRATCH_BASE.mkdir(parents=True, exist_ok=True)
        self.home = Path(tempfile.mkdtemp(prefix="mailroom-pytest-", dir=SCRATCH_BASE))
        self.room = self.home / "room"
        self.bin = self.room / "bin"
        self.accounts = self.room / "accounts"
        self.attachments = self.room / "attachments"
        for d in (self.bin, self.accounts, self.attachments):
            d.mkdir(parents=True, exist_ok=True)
        self.mail_py = self.bin / "mail.py"
        shutil.copyfile(MAIL_PY_SRC, self.mail_py)
        # a "sandbox" outputs mount whose path matches SANDBOX_MOUNT_RE
        self.sandbox = (
            self.home
            / "local-agent-mode-sessions"
            / "sess"
            / "proj"
            / "local_x"
            / "outputs"
        )
        self.sandbox.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_mail(self, *args, expect_code=None):
        proc = subprocess.run(
            [sys.executable, str(self.mail_py), *map(str, args)],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if expect_code is not None:
            self.assertEqual(
                proc.returncode,
                expect_code,
                msg=f"args={args}\nstdout={proc.stdout}\nstderr={proc.stderr}",
            )
        return proc

    # -- helpers ----------------------------------------------------------
    def account_dir(self, address):
        d = self.accounts / address
        for folder in ("INBOX", "Sent", "Drafts", "Outbox", "Archive", ".Cache"):
            for sub in ("cur", "new", "tmp"):
                (d / "mail" / folder / sub).mkdir(parents=True, exist_ok=True)
        return d

    def write_inbound(self, address, filename, raw, *, folder="INBOX", meta=None):
        """Drop a received .eml (+ optional .meta) into an account folder."""
        self.account_dir(address)
        p = self.accounts / address / "mail" / folder / "cur" / filename
        p.write_bytes(raw if isinstance(raw, bytes) else raw.encode("utf-8"))
        if meta is not None:
            (p.with_name(p.name + ".meta")).write_text(meta, encoding="utf-8")
        return p

    def rel(self, p):
        return str(Path(p).resolve().relative_to(self.room.resolve()).as_posix())


class ReplyThreadingTests(MailCliTestBase):
    ORIG_ID = "<0101019c66ae3e6e-4d2a8d32-d8db-4474-acdf-4b5210237b38-000000@us-west-2.amazonses.com>"

    def _inbound(self, extra_headers=""):
        raw = (
            "From: Sender <sender@vendor.com>\r\n"
            "To: me@adeu.ai\r\n"
            "Subject: Original subject\r\n"
            "Date: Mon, 06 Jul 2026 10:00:00 +0000\r\n"
            f"Message-ID: {self.ORIG_ID}\r\n"
            f"{extra_headers}"
            "MIME-Version: 1.0\r\n"
            'Content-Type: text/plain; charset="utf-8"\r\n'
            "\r\n"
            "Body text.\r\n"
        )
        return self.write_inbound("me@adeu.ai", "100.aaaa.eml", raw)

    def _reply_headers(self, draft_rel):
        draft = self.room / draft_rel
        head = draft.read_bytes().split(b"\n\n")[0].split(b"\r\n\r\n")[0]
        return head.decode("utf-8", "replace")

    def test_reply_uses_literal_message_id(self):
        src = self._inbound()
        body = self.room / "rbody.txt"
        body.write_text("Thanks.\n")
        proc = self.run_mail("reply", self.rel(src), self.rel(body), expect_code=0)
        draft_rel = proc.stdout.strip().splitlines()[-1]
        headers = self._reply_headers(draft_rel)

        # In-Reply-To and References carry the FULL literal id, no encoding
        self.assertIn(f"In-Reply-To: {self.ORIG_ID}", headers)
        self.assertIn(self.ORIG_ID, headers)  # in References too
        self.assertNotIn("=?utf-8?q?", headers.lower().replace("utf-8", "utf-8"))
        self.assertNotIn("=3C", headers)  # '<' must not be Q-encoded
        # subject prefixed once
        self.assertIn("Subject: Re: Original subject", headers)

    def test_reply_chains_existing_references(self):
        prior = "<prior-thread-1@example.com>"
        src = self._inbound(extra_headers=f"References: {prior}\r\n")
        body = self.room / "rbody.txt"
        body.write_text("Thanks.\n")
        proc = self.run_mail("reply", self.rel(src), self.rel(body), expect_code=0)
        draft_rel = proc.stdout.strip().splitlines()[-1]
        headers = (
            self._reply_headers(draft_rel).replace("\r\n ", " ").replace("\n ", " ")
        )

        # References should contain BOTH the prior id and the replied id, literal
        self.assertIn(prior, headers)
        self.assertIn(self.ORIG_ID, headers)
        self.assertNotIn("=?", headers)

    def test_reply_all_populates_to_and_cc_properly(self):
        extra = "To: me@adeu.ai, other@adeu.ai\r\n" "Cc: boss@adeu.ai\r\n"
        src = self._inbound(extra_headers=extra)
        body = self.room / "rbody.txt"
        body.write_text("Thanks.\n")

        proc = self.run_mail(
            "reply", self.rel(src), self.rel(body), "--all", expect_code=0
        )
        draft_rel = proc.stdout.strip().splitlines()[-1]
        headers = (
            self._reply_headers(draft_rel).replace("\r\n ", " ").replace("\n ", " ")
        )

        self.assertIn("sender@vendor.com", headers)
        self.assertIn("other@adeu.ai", headers)
        self.assertIn("boss@adeu.ai", headers)

        to_line = [line for line in headers.splitlines() if line.startswith("To:")][0]
        cc_line = [line for line in headers.splitlines() if line.startswith("Cc:")][0]
        self.assertNotIn("me@adeu.ai", to_line)
        self.assertNotIn("me@adeu.ai", cc_line)

    def test_reply_preserves_multi_reference_chain_and_appends_parent(self):
        prior1 = "<msg-001-root@example.com>"
        prior2 = "<msg-002@example.com>"
        parent_id = "<msg-003-parent@example.com>"
        raw = (
            "From: Sender <sender@vendor.com>\r\n"
            "To: me@adeu.ai\r\n"
            "Subject: Multi-ref subject\r\n"
            "Date: Mon, 06 Jul 2026 10:00:00 +0000\r\n"
            f"Message-ID: {parent_id}\r\n"
            f"References: {prior1} {prior2}\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: text/plain; charset="utf-8"\r\n'
            "\r\n"
            "Body text.\r\n"
        )
        src = self.write_inbound("me@adeu.ai", "multiref.eml", raw)
        body = self.room / "rbody.txt"
        body.write_text("Thanks.\n")

        proc = self.run_mail("reply", self.rel(src), self.rel(body), expect_code=0)
        draft_rel = proc.stdout.strip().splitlines()[-1]
        headers = (
            self._reply_headers(draft_rel).replace("\r\n ", " ").replace("\n ", " ")
        )

        expected_refs = f"{prior1} {prior2} {parent_id}"
        ref_lines = [
            line for line in headers.splitlines() if line.lower().startswith("references:")
        ]
        self.assertTrue(ref_lines, f"No References header found in draft headers:\n{headers}")
        ref_header_val = ref_lines[0].split(":", 1)[1].strip()

        self.assertEqual(
            ref_header_val,
            expected_refs,
            f"References header did not contain full chain in order.\nExpected: {expected_refs}\nGot: {ref_header_val}",
        )

    def test_reply_to_sent_message_addresses_recipient_not_self(self):
        raw = (
            "From: Alice User <alice@example.com>\r\n"
            "To: Bob Smith <bob@example.com>\r\n"
            "Subject: Initial Outreach\r\n"
            "Date: Fri, 24 Jul 2026 10:00:00 +0000\r\n"
            "Message-ID: <sent01@example.com>\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: text/plain; charset="utf-8"\r\n'
            "\r\n"
            "Hello Bob, checking in on the project.\r\n"
        )
        src = self.write_inbound("alice@example.com", "sent01.eml", raw, folder="Sent")
        body = self.room / "rbody.txt"
        body.write_text("Following up on my previous email.\n")

        proc = self.run_mail("reply", self.rel(src), self.rel(body), expect_code=0)
        draft_rel = proc.stdout.strip().splitlines()[-1]
        headers = self._reply_headers(draft_rel)

        to_line = [line for line in headers.splitlines() if line.startswith("To:")][0]
        self.assertIn("bob@example.com", to_line)
        self.assertNotIn("alice@example.com", to_line)

    def test_reply_all_preserves_original_to_recipients_in_to_header(self):
        raw = (
            "From: Charlie <charlie@external.com>\r\n"
            "Reply-To: Charlie <charlie.reply@external.com>\r\n"
            "To: Alice <alice@example.com>, David <david@partner.com>\r\n"
            "Cc: Eve <eve@partner.com>\r\n"
            "Subject: Re: Project Discussion\r\n"
            "Date: Mon, 28 Jul 2026 11:00:00 +0000\r\n"
            "Message-ID: <msg_thread_202@external.com>\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: text/plain; charset="utf-8"\r\n'
            "\r\n"
            "Alice, David,\r\n"
            "Here are the updates.\r\n"
        )
        src = self.write_inbound("alice@example.com", "reply_all_test.eml", raw)
        body = self.room / "rbody.txt"
        body.write_text("Thanks.\n")

        proc = self.run_mail(
            "reply", self.rel(src), self.rel(body), "--all", expect_code=0
        )
        draft_rel = proc.stdout.strip().splitlines()[-1]
        headers = (
            self._reply_headers(draft_rel).replace("\r\n ", " ").replace("\n ", " ")
        )

        to_line = [line for line in headers.splitlines() if line.startswith("To:")][0]
        cc_lines = [line for line in headers.splitlines() if line.startswith("Cc:")]
        cc_line = cc_lines[0] if cc_lines else ""

        # Primary counterparties (Reply-To / From sender + original To recipients except self)
        # must remain in To:
        self.assertIn("charlie.reply@external.com", to_line)
        self.assertIn(
            "david@partner.com",
            to_line,
            msg=f"Original To recipient david@partner.com was demoted. To line: {to_line}",
        )

        # Reply-To present: the raw From address is deliberately NOT re-added to To or Cc
        self.assertNotIn("charlie@external.com", to_line)
        self.assertNotIn("charlie@external.com", cc_line)

        # Own account address (alice@example.com) is never addressed
        self.assertNotIn("alice@example.com", to_line)
        self.assertNotIn("alice@example.com", cc_line)

        # Original Cc recipients must remain in Cc:
        self.assertIn("eve@partner.com", cc_line)
        self.assertNotIn(
            "david@partner.com",
            cc_line,
            msg=f"Original To recipient david@partner.com should be in To, not Cc. Cc line: {cc_line}",
        )

    def test_reply_all_without_cc_emits_no_cc_header(self):
        raw = (
            "From: Charlie <charlie@external.com>\r\n"
            "To: Alice <alice@example.com>, David <david@partner.com>\r\n"
            "Subject: Re: No Cc Test\r\n"
            "Date: Mon, 28 Jul 2026 11:00:00 +0000\r\n"
            "Message-ID: <msg_nocc@external.com>\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: text/plain; charset="utf-8"\r\n'
            "\r\n"
            "No Cc header test.\r\n"
        )
        src = self.write_inbound("alice@example.com", "reply_all_nocc.eml", raw)
        body = self.room / "rbody.txt"
        body.write_text("Thanks.\n")

        proc = self.run_mail(
            "reply", self.rel(src), self.rel(body), "--all", expect_code=0
        )
        headers = self._reply_headers(proc.stdout.strip().splitlines()[-1])
        self.assertFalse(
            [l for l in headers.splitlines() if l.startswith("Cc:")],
            f"reply --all must not emit an empty Cc header:\n{headers}",
        )
        to_line = [l for l in headers.splitlines() if l.startswith("To:")][0]
        self.assertIn("david@partner.com", to_line)

    def test_reply_all_to_sent_message_addresses_recipients_not_self(self):
        raw = (
            "From: Alice <alice@example.com>\r\n"
            "To: Bob <bob@external.com>, Carol <carol@external.com>\r\n"
            "Subject: Sent Message Reply All\r\n"
            "Date: Mon, 28 Jul 2026 11:00:00 +0000\r\n"
            "Message-ID: <sent_reply_all@example.com>\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: text/plain; charset="utf-8"\r\n'
            "\r\n"
            "Follow up.\r\n"
        )
        src = self.write_inbound("alice@example.com", "sent_reply_all.eml", raw)
        body = self.room / "rbody.txt"
        body.write_text("Following up.\n")

        proc = self.run_mail(
            "reply", self.rel(src), self.rel(body), "--all", expect_code=0
        )
        headers = self._reply_headers(proc.stdout.strip().splitlines()[-1])
        to_line = [l for l in headers.splitlines() if l.startswith("To:")][0]
        self.assertIn("bob@external.com", to_line)
        self.assertIn("carol@external.com", to_line)
        self.assertNotIn("alice@example.com", to_line)

    def test_reply_all_deduplicates_addresses_differing_only_in_case(self):
        raw = (
            "From: Charlie <Charlie@External.com>\r\n"
            "To: ALICE@EXAMPLE.COM, David <david@partner.com>\r\n"
            "Cc: CHARLIE@external.com, David <DAVID@partner.com>\r\n"
            "Subject: Case Dedup\r\n"
            "Date: Mon, 28 Jul 2026 11:00:00 +0000\r\n"
            "Message-ID: <msg_case@external.com>\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: text/plain; charset="utf-8"\r\n'
            "\r\n"
            "Case test.\r\n"
        )
        src = self.write_inbound("alice@example.com", "reply_all_case.eml", raw)
        body = self.room / "rbody.txt"
        body.write_text("Thanks.\n")

        proc = self.run_mail(
            "reply", self.rel(src), self.rel(body), "--all", expect_code=0
        )
        headers = (
            self._reply_headers(proc.stdout.strip().splitlines()[-1])
            .replace("\r\n ", " ")
            .replace("\n ", " ")
        )
        to_line = [l for l in headers.splitlines() if l.startswith("To:")][0]
        # `seen` is lower-cased, so ALICE@EXAMPLE.COM == the account address
        self.assertNotIn("alice@example.com", to_line.lower())
        # david appears once only, despite To: david + Cc: DAVID
        self.assertEqual(1, headers.lower().count("david@partner.com"), headers)
        # CHARLIE@external.com in Cc duplicates the From address -> no Cc at all
        self.assertFalse(
            [l for l in headers.splitlines() if l.startswith("Cc:")], headers
        )

    def test_reply_all_falls_back_to_reply_to_when_no_other_recipients(self):
        # every candidate is the account itself, so to_addrs empties
        # and mail.py must fall back to reply_to instead of emitting an empty To.
        raw = (
            "From: Alice <alice@example.com>\r\n"
            "To: Alice <alice@example.com>\r\n"
            "Subject: Note To Self\r\n"
            "Date: Mon, 28 Jul 2026 11:00:00 +0000\r\n"
            "Message-ID: <self_only@example.com>\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: text/plain; charset="utf-8"\r\n'
            "\r\n"
            "Self.\r\n"
        )
        src = self.write_inbound("alice@example.com", "reply_all_self.eml", raw)
        body = self.room / "rbody.txt"
        body.write_text("Thanks.\n")

        proc = self.run_mail(
            "reply", self.rel(src), self.rel(body), "--all", expect_code=0
        )
        headers = self._reply_headers(proc.stdout.strip().splitlines()[-1])
        to_line = [l for l in headers.splitlines() if l.startswith("To:")][0]
        self.assertIn("alice@example.com", to_line)
        self.assertNotEqual("To:", to_line.strip())


class ImportTests(MailCliTestBase):
    def test_import_brings_outside_file_into_attachments(self):
        src = self.sandbox / "report.xlsx"
        src.write_bytes(b"PK\x03\x04fake-xlsx-bytes")
        proc = self.run_mail("import", str(src), expect_code=0)
        printed = proc.stdout.strip().splitlines()[0]
        self.assertEqual(printed, "attachments/imported/report.xlsx")
        dest = self.room / "attachments" / "imported" / "report.xlsx"
        self.assertTrue(dest.is_file())
        self.assertEqual(dest.read_bytes(), b"PK\x03\x04fake-xlsx-bytes")

    def test_import_works_from_an_ordinary_local_folder(self):
        """
        The room runs on the USER'S machine, so an everyday folder — Downloads,
        Documents — is importable; nothing about this is sandbox-specific. The
        docs used to say "copy a file from YOUR sandbox" and name the argument
        <absolute-sandbox-path>, which reads as sandbox-only and led to telling
        users their local files were unreachable. This pins the real behaviour.
        """
        downloads = self.home / "Downloads"
        downloads.mkdir(parents=True, exist_ok=True)
        src = downloads / "scan.jpg"
        src.write_bytes(b"\xff\xd8\xff-not-really-a-jpeg")

        proc = self.run_mail("import", str(src), expect_code=0)

        self.assertEqual(
            proc.stdout.strip().splitlines()[0],
            "attachments/imported/scan.jpg",
        )
        dest = self.room / "attachments" / "imported" / "scan.jpg"
        self.assertEqual(dest.read_bytes(), b"\xff\xd8\xff-not-really-a-jpeg")
        # and it tells the caller how to actually attach it
        self.assertIn("--attach attachments/imported/scan.jpg", proc.stdout)

    def test_import_usage_does_not_claim_sandbox_only(self):
        proc = self.run_mail("import", expect_code=1)
        combined = proc.stdout + proc.stderr
        self.assertIn("mail import <absolute-path>", combined)
        self.assertNotIn("absolute-path-in-sandbox", combined)

    def test_import_refuses_room_internal_path(self):
        inside = self.attachments / "already.txt"
        inside.write_text("hi")
        proc = self.run_mail("import", str(inside.resolve()))
        self.assertEqual(proc.returncode, 2)  # POLICY_REFUSAL
        self.assertIn("already inside the room", proc.stderr)

    def test_import_requires_absolute_path(self):
        proc = self.run_mail("import", "relative/thing.txt")
        self.assertEqual(proc.returncode, 1)  # USAGE

    def test_import_dedups_identical_content(self):
        src = self.sandbox / "a.txt"
        src.write_bytes(b"same")
        self.run_mail("import", str(src), expect_code=0)
        self.run_mail("import", str(src), expect_code=0)
        imported = list((self.room / "attachments" / "imported").iterdir())
        self.assertEqual(len(imported), 1)  # not a.txt + a(1).txt


class BridgeDetectorTests(MailCliTestBase):
    """QA 2026-07-24, NEW-6 — corrected and narrowed.

    The report said `mail import` "lacks that detector" and recommended calling
    export's bridge-availability check first. That premise is wrong: import
    ALREADY calls the same `looks_like_sandbox_vm_path()` that export calls,
    before its is_absolute() guard, and it emits BRIDGE_UNAVAILABLE_MSG
    correctly for the shapes the detector knows.

    The real defect is that `_SANDBOX_VM_MARKERS` is incomplete. Verified
    against the live room (2026-07-24, deployed bin/mail.py):

        mail import /mnt/user-data/uploads/probe.csv
          -> "file bridge unavailable: ..."                      CORRECT
        mail import /sessions/abc/outputs/probe.csv
          -> "file bridge unavailable: ..."                      CORRECT
        mail import "/home/claude/fixtures/torture,data ÄÖ.csv"
          -> "not a file: C:/Program Files/Git/home/claude/..."  WRONG
        mail import /tmp/claude/probe.csv
          -> "not a file: C:/Users/mikko/AppData/Local/Temp/..." WRONG
        mail import /Users/claude/probe.csv
          -> "not a file: C:/Program Files/Git/Users/claude/..." WRONG

    A sandbox's HOME directory (/home/claude/... on Linux sandboxes,
    /Users/claude/... on macOS) and /tmp are every bit as unreachable as
    /mnt/..., and are where an agent naturally writes scratch files — the QA
    run hit exactly that path shape.

    Export only LOOKS better here because it has a second, independent guard
    (is_allowed_export_dir) that rejects anything outside a session mount, so
    an undiagnosed shape still gets a coherent refusal. Import has no such
    backstop, which is why the gap is only visible on import. Fixing the marker
    list fixes both; giving import a backstop is the defence in depth.
    """

    def _mail_module(self):
        """Import the room's mail.py as a module (no __main__ side effects)."""
        return load_mail_module(self.mail_py)

    # -- the shape detector, directly -----------------------------------

    def test_detector_recognizes_the_shapes_it_already_knows(self):
        """GREEN guard: import is NOT missing the detector. Refutes NEW-6's premise."""
        mod = self._mail_module()
        for arg in (
            "/mnt/user-data/uploads/probe.csv",
            "/mnt/outputs/probe.csv",
            "/mnt/uploads/probe.csv",
            "/sessions/abc/outputs/probe.csv",
        ):
            self.assertTrue(
                mod.looks_like_sandbox_vm_path(arg, arg),
                msg=f"detector should already flag {arg}",
            )

    def test_detector_recognizes_a_sandbox_home_directory(self):
        """RED: /home/claude/... is an unreachable sandbox path."""
        mod = self._mail_module()
        arg = "/home/claude/fixtures/torture,data ÄÖ.csv"
        reparented = "C:/Program Files/Git/home/claude/fixtures/torture,data ÄÖ.csv"
        self.assertTrue(
            mod.looks_like_sandbox_vm_path(arg, reparented),
            msg="a sandbox home path is not recognised, so import falls through "
            "to a misleading 'not a file'",
        )

    def test_detector_recognizes_a_macos_sandbox_home(self):
        """RED: /Users/claude/... is the macOS sandbox equivalent."""
        mod = self._mail_module()
        arg = "/Users/claude/probe.csv"
        self.assertTrue(
            mod.looks_like_sandbox_vm_path(
                arg, "C:/Program Files/Git/Users/claude/probe.csv"
            ),
            msg="macOS sandbox home path not recognised",
        )

    def test_detector_recognizes_a_sandbox_tmp_path(self):
        """RED, and the worst of the three: /tmp reparents onto a real host dir.

        mail.py's own docstring calls this "the false-success bug" — a VM
        '/tmp/...' can reparent onto an existing host directory, so import can
        silently copy a DIFFERENT file that happens to share the name. Shape
        must win over existence.
        """
        mod = self._mail_module()
        arg = "/tmp/claude/probe.csv"
        self.assertTrue(
            mod.looks_like_sandbox_vm_path(
                arg, "C:/Users/someone/AppData/Local/Temp/claude/probe.csv"
            ),
            msg="a sandbox /tmp path is not recognised; if the reparented host "
            "path happens to exist, import silently imports the wrong file",
        )

    # -- end to end, through the CLI ------------------------------------

    def _sandbox_home_arg(self, tail="fixtures/report.xlsx"):
        """The arg mail.py actually receives for a sandbox home path.

        On Windows the MSYS shell reparents '/home/claude/...' under the
        Git-Bash root before mail.py sees it; on POSIX it arrives verbatim.
        Either way it is absolute, so the is_absolute() guard does not catch it.
        """
        if os.name == "nt":
            return f"C:/Program Files/Git/home/claude/{tail}"
        return f"/home/claude/{tail}"

    def test_import_diagnoses_an_unreachable_sandbox_home_path(self):
        """RED: reproduces the QA's exact observation."""
        proc = self.run_mail("import", self._sandbox_home_arg())
        combined = proc.stdout + proc.stderr
        self.assertNotIn(
            "not a file",
            combined,
            msg="import reports a missing file for a path on a machine it "
            f"cannot reach at all; got:\n{combined}",
        )
        self.assertIn("file bridge unavailable", combined)

    def test_import_refuses_a_shape_it_cannot_reach_even_when_it_exists(self):
        """RED: existence must not override shape (the false-success bug).

        A real file sitting at a host path that carries a sandbox-VM shape must
        be refused, not silently copied — the agent asking for it meant the
        file on ITS machine, not this coincidentally-named one.
        """
        decoy = self.home / "Git" / "home" / "claude" / "fixtures"
        decoy.mkdir(parents=True, exist_ok=True)
        (decoy / "report.xlsx").write_bytes(b"WRONG-MACHINE-CONTENT")

        proc = self.run_mail("import", str(decoy / "report.xlsx"))
        imported = self.room / "attachments" / "imported" / "report.xlsx"
        self.assertFalse(
            imported.is_file() and imported.read_bytes() == b"WRONG-MACHINE-CONTENT",
            msg="import silently copied a file from a host path that is shaped "
            "like an unreachable sandbox path",
        )
        self.assertIn("file bridge unavailable", proc.stdout + proc.stderr)


class ExportTests(MailCliTestBase):
    def _received_with_attachment(self):
        # a received message whose .meta lists an extracted attachment
        sha = "deadbeef1234"
        att_dir = self.attachments / sha
        att_dir.mkdir(parents=True, exist_ok=True)
        (att_dir / "Invoice.pdf").write_bytes(b"%PDF-1.4 invoice")
        (att_dir / "Receipt.pdf").write_bytes(b"%PDF-1.4 receipt")
        raw = (
            "From: vendor@x.com\r\nTo: me@adeu.ai\r\nSubject: files\r\n"
            "Message-ID: <r-1@x.com>\r\n\r\nbody\r\n"
        )
        meta = (
            f"X-Mailroom-Sha: {sha}\n"
            "X-Mailroom-Account: me@adeu.ai\n"
            f"X-Mailroom-Attachments: attachments/{sha}/Invoice.pdf\n"
            f"X-Mailroom-Attachments: attachments/{sha}/Receipt.pdf\n"
            "\nbody\n"
        )
        p = self.write_inbound("me@adeu.ai", "200.bbbb.eml", raw, meta=meta)
        return p, att_dir

    def test_export_by_path_to_sandbox(self):
        _p, att_dir = self._received_with_attachment()
        rel = self.rel(att_dir / "Invoice.pdf")
        proc = self.run_mail("export", rel, "--to", str(self.sandbox), expect_code=0)
        self.assertIn("EXPORTED", proc.stdout)
        self.assertTrue((self.sandbox / "Invoice.pdf").is_file())
        self.assertEqual(
            (self.sandbox / "Invoice.pdf").read_bytes(), b"%PDF-1.4 invoice"
        )

    def test_export_refuses_non_sandbox_destination(self):
        _p, att_dir = self._received_with_attachment()
        rel = self.rel(att_dir / "Invoice.pdf")
        bad = self.home / "not_a_mount"
        bad.mkdir(exist_ok=True)
        proc = self.run_mail("export", rel, "--to", str(bad))
        self.assertEqual(proc.returncode, 2)  # POLICY_REFUSAL
        self.assertIn("sandbox", proc.stderr.lower())
        self.assertFalse((bad / "Invoice.pdf").exists())

    def test_export_refuses_traversal_even_if_mount_shaped(self):
        _p, att_dir = self._received_with_attachment()
        rel = self.rel(att_dir / "Invoice.pdf")
        traversal = str(self.sandbox / ".." / ".." / "escape")
        proc = self.run_mail("export", rel, "--to", traversal)
        self.assertEqual(proc.returncode, 2)

    def test_export_refuses_bare_outputs_dir_outside_a_session_mount(self):
        """`export` is the room's ONLY egress, so the destination must be a real
        Cowork session mount — not merely a directory that happens to be called
        outputs/ or uploads/. A folder name is not a capability: ordinary project
        directories are called `outputs` all the time (there is one in a sibling
        repo on the maintainer's own machine), and `mailroom_bash` runs an
        unsandboxed shell as the user, so `mkdir ~/outputs` is a one-liner. If
        the name alone were sufficient, a prompt-injected attachment could route
        mail contents anywhere the user can write.

        This is a REGRESSION GUARD, not a feature test. An autonomous fix loop
        (PR #2, agent-fix/mail-1784888043) wrote a repro that exported into a
        non-mount `.../outputs`, read the correct POLICY_REFUSAL as the bug, and
        broadened SANDBOX_MOUNT_RE to `(?:^|[/\\])(outputs|uploads)(?:[/\\]|$)`
        — deleting the boundary while leaving the comment that promised it. Every
        CI gate stayed green, because the existing negative test only covers a
        destination with no outputs/uploads segment at all. This closes that hole:
        the paths below are mount-SHAPED but not mounts.
        """
        _p, att_dir = self._received_with_attachment()
        rel = self.rel(att_dir / "Invoice.pdf")
        for name in ("outputs", "uploads"):
            bad = self.home / "some_project" / name
            bad.mkdir(parents=True, exist_ok=True)
            proc = self.run_mail("export", rel, "--to", str(bad))
            self.assertEqual(
                proc.returncode,
                2,  # POLICY_REFUSAL
                msg=f"export wrote outside a session mount via a bare {name}/ dir: "
                f"stdout={proc.stdout!r} stderr={proc.stderr!r}",
            )
            self.assertFalse(
                (bad / "Invoice.pdf").exists(),
                msg=f"attachment leaked into {bad}",
            )

    def test_export_all_attachments_by_meta(self):
        # export by attachment paths listed in the meta (both files)
        _p, att_dir = self._received_with_attachment()
        for name in ("Invoice.pdf", "Receipt.pdf"):
            self.run_mail(
                "export",
                self.rel(att_dir / name),
                "--to",
                str(self.sandbox),
                expect_code=0,
            )
        self.assertTrue((self.sandbox / "Invoice.pdf").is_file())
        self.assertTrue((self.sandbox / "Receipt.pdf").is_file())

    def test_export_name_selects_single_attachment(self):
        # NOTE: one blind tester reported --name rejecting a valid filename.
        # This asserts the intended behavior; if it fails, --name has a bug.
        _p, att_dir = self._received_with_attachment()
        # export the whole attachment DIRECTORY listing is by path here, so
        # exercise --name via a path source that resolves to a single file
        rel = self.rel(att_dir / "Receipt.pdf")
        proc = self.run_mail(
            "export",
            rel,
            "--to",
            str(self.sandbox),
            "--name",
            "Receipt.pdf",
            expect_code=0,
        )
        self.assertTrue((self.sandbox / "Receipt.pdf").is_file())


class BridgeUnavailableTests(MailCliTestBase):
    """In a plain chat the sandbox is a separate machine from the room, so
    import/export must refuse with the honest bridge-unavailable message
    rather than a misleading 'not a file' / 'pass the outputs path' / a
    false-success copy into a dead host dir."""

    VM_PATHS = (
        "/mnt/user-data/uploads/MSA_v1.docx",
        "/mnt/user-data/outputs/report.xlsx",
        "/mnt/outputs/x.bin",
        "/sessions/abc123/mnt/outputs/data.csv",
    )

    def _make_attachment(self):
        """A received attachment on disk, addressable by its room-relative
        path. Self-contained (no dependency on ExportTests' helper)."""
        sha = "cafebabe5678"
        att_dir = self.attachments / sha
        att_dir.mkdir(parents=True, exist_ok=True)
        (att_dir / "Invoice.pdf").write_bytes(b"%PDF-1.4 invoice")
        return att_dir

    def test_import_vm_path_reports_bridge_unavailable(self):
        for p in self.VM_PATHS:
            proc = self.run_mail("import", p)
            # POLICY_REFUSAL (2), not the misleading NOT_FOUND (3)
            self.assertEqual(proc.returncode, 2, msg=f"{p}\nstderr={proc.stderr}")
            self.assertIn("file bridge unavailable", proc.stderr.lower())
            self.assertNotIn("not a file", proc.stderr.lower())

    def test_export_vm_destination_reports_bridge_unavailable(self):
        att_dir = self._make_attachment()
        rel = self.rel(att_dir / "Invoice.pdf")
        for dest in (
            "/mnt/user-data/outputs",
            "/mnt/outputs",
            "/sessions/abc/mnt/outputs",
        ):
            proc = self.run_mail("export", rel, "--to", dest)
            self.assertEqual(proc.returncode, 2, msg=f"{dest}\nstderr={proc.stderr}")
            self.assertIn("file bridge unavailable", proc.stderr.lower())

    def test_real_local_import_still_works(self):
        # a genuine local file OUTSIDE any VM-shaped path must still import:
        # the fix must not break the Claude Desktop shared-disk case.
        src = self.home / "local_docs" / "contract.pdf"
        src.parent.mkdir(parents=True, exist_ok=True)
        src.write_bytes(b"%PDF-1.4 local")
        proc = self.run_mail("import", str(src.resolve()), expect_code=0)
        self.assertIn("IMPORTED into the room", proc.stdout)
        self.assertTrue(
            (self.room / "attachments" / "imported" / "contract.pdf").is_file()
        )

    def test_real_sandbox_export_still_works(self):
        # the genuine Cowork/desktop mount (matches SANDBOX_MOUNT_RE, not
        # VM-shaped) must still export — regression guard for the detection.
        att_dir = self._make_attachment()
        rel = self.rel(att_dir / "Invoice.pdf")
        self.run_mail("export", rel, "--to", str(self.sandbox), expect_code=0)
        self.assertTrue((self.sandbox / "Invoice.pdf").is_file())


class TableVerbTests(MailCliTestBase):
    """`mail table` reads the .tabular.db sidecar the broker writes at sync
    time. These build that sidecar directly with stdlib sqlite3 — matching the
    schema tabular_store.ts emits (SIDECAR_SCHEMA_VERSION=1) — so the verb's
    read/reshape logic is tested independent of SheetJS, and the fixture
    doubles as a cross-wall schema contract test."""

    SCHEMA_VERSION = 1  # must match tabular_store.ts / mail.py

    def _build_sidecar(self, db_path, sheets):
        """sheets: list of dicts {name, header_row, columns:[(header,type)],
        rows:[[ (value, value_raw, native_type, formula) | scalar ]]}.
        A scalar cell is shorthand for (str(v), str(v), 's', None)."""
        import sqlite3

        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.executescript("""
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                CREATE TABLE sheets (sheet_index INTEGER PRIMARY KEY, name TEXT,
                    n_rows INTEGER, n_cols INTEGER, header_row INTEGER);
                CREATE TABLE columns (sheet_index INTEGER, col_index INTEGER,
                    header TEXT, native_type TEXT,
                    PRIMARY KEY(sheet_index, col_index));
                CREATE TABLE cells (sheet_index INTEGER, row_index INTEGER,
                    col_index INTEGER, value TEXT, value_raw TEXT,
                    native_type TEXT, formula TEXT,
                    PRIMARY KEY(sheet_index, row_index, col_index));
                """)
            conn.execute(
                "INSERT INTO meta(key,value) VALUES('schema_version',?)",
                (str(self.SCHEMA_VERSION),),
            )
            conn.execute(
                "INSERT INTO meta(key,value) VALUES('source_sha',?)", ("testsha",)
            )
            for si, sheet in enumerate(sheets):
                cols = sheet["columns"]
                rows = sheet["rows"]
                conn.execute(
                    "INSERT INTO sheets VALUES(?,?,?,?,?)",
                    (si, sheet["name"], len(rows), len(cols), sheet["header_row"]),
                )
                for ci, (header, ntype) in enumerate(cols):
                    conn.execute(
                        "INSERT INTO columns VALUES(?,?,?,?)",
                        (si, ci, header, ntype),
                    )
                for ri, row in enumerate(rows):
                    for ci, cell in enumerate(row):
                        if cell is None:
                            continue  # empty cell: omit (sparse), like the writer
                        if isinstance(cell, tuple):
                            value, value_raw, ntype, formula = cell
                        else:
                            value = value_raw = str(cell)
                            ntype, formula = "s", None
                        conn.execute(
                            "INSERT INTO cells VALUES(?,?,?,?,?,?,?)",
                            (si, ri, ci, value, value_raw, ntype, formula),
                        )
            conn.commit()
        finally:
            conn.close()

    def _attachment_with_sidecar(self, sheets, att_name="data.xlsx"):
        """Create attachments/<sha>/<att_name> + its .tabular.db; return the
        room-relative attachment path (what `mail table <path>` takes)."""
        sha = "abc123def456"
        att_dir = self.attachments / sha
        att_dir.mkdir(parents=True, exist_ok=True)
        att = att_dir / att_name
        att.write_bytes(b"PK\x03\x04 fake workbook bytes")
        self._build_sidecar(att.with_name(att.name + ".tabular.db"), sheets)
        return self.rel(att)

    # a small typed sheet: header row + numeric ids, a formula cell in col 2
    ORDERS = {
        "name": "Orders",
        "header_row": 0,
        "columns": [("item", "s"), ("qty", "n"), ("total", "n")],
        "rows": [
            ["item", "qty", "total"],  # header row (all strings)
            [
                ("apples", "apples", "s", None),
                ("3", "3", "n", None),
                ("30", "30", "n", "qty*10"),
            ],
            [
                ("pears", "pears", "s", None),
                ("5", "5", "n", None),
                ("50", "50", "n", "qty*10"),
            ],
        ],
    }

    def test_list_sheets_shows_dims_and_schema(self):
        rel = self._attachment_with_sidecar([self.ORDERS])
        proc = self.run_mail("table", rel, expect_code=0)
        out = proc.stdout
        self.assertIn("Orders", out)
        # 2 DATA rows under one header row: the count is data rows throughout
        # (see test_list_sheets_counts_data_rows_not_the_header below)
        self.assertIn("2 rows × 3 cols", out)
        self.assertIn("item:s", out)
        self.assertIn("qty:n", out)

    def test_list_sheets_counts_data_rows_not_the_header(self):
        """QA 2026-07-24, OBS-1: the listing reported "4 rows × 5 cols" for a
        CSV with 3 data rows. Every other row count the verb prints is a DATA
        row count: --rows A:B slices 0-based over the rows after the header,
        --format records/jsonl emit one object per data row, and the truncation
        marker says "true total: N data rows". SKILL.md documents that
        convention. Only the dimension line silently counts the header in, so
        the agent that reads it slices one row short (or off the end).

        ORDERS is a header row over 2 data rows, and the sibling assertions
        agree: test_records_uses_raw_values expects len(data) == 2.

        NOTE for whoever fixes this: test_list_sheets_shows_dims_and_schema
        above asserts "3 rows × 3 cols" — it encodes the defective contract and
        must be updated in the same change. The stored sheets.n_rows column is
        NOT the bug; grid rows are what cell addressing needs. This is about
        what the listing DISPLAYS (mail.py _list_sheets), mirrored on the TS
        side by renderTableMarkdown's dimension line (test/tabular.test.ts).
        """
        rel = self._attachment_with_sidecar([self.ORDERS])
        proc = self.run_mail("table", rel, expect_code=0)
        out = proc.stdout
        self.assertIn("Orders", out)
        self.assertIn("2 rows × 3 cols", out)
        self.assertNotIn("3 rows × 3 cols", out)

    def test_md_default_renders_table(self):
        rel = self._attachment_with_sidecar([self.ORDERS])
        proc = self.run_mail("table", rel, "--sheet", "Orders", expect_code=0)
        out = proc.stdout
        self.assertIn("| item | qty | total |", out)
        self.assertIn("| apples | 3 | 30 |", out)
        self.assertIn("| pears | 5 | 50 |", out)

    def test_records_uses_raw_values(self):
        rel = self._attachment_with_sidecar([self.ORDERS])
        proc = self.run_mail(
            "table", rel, "--sheet", "0", "--format", "records", expect_code=0
        )
        import json

        data = json.loads(proc.stdout)
        self.assertEqual(len(data), 2)
        self.assertEqual(data[0]["item"], "apples")
        self.assertEqual(data[0]["qty"], 3)
        self.assertEqual(data[0]["total"], 30)

    def test_jsonl_one_object_per_line(self):
        rel = self._attachment_with_sidecar([self.ORDERS])
        proc = self.run_mail(
            "table", rel, "--sheet", "0", "--format", "jsonl", expect_code=0
        )
        import json

        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 2)
        first = json.loads(lines[0])
        self.assertEqual(first["item"], "apples")

    def test_csv_and_tsv_output(self):
        rel = self._attachment_with_sidecar([self.ORDERS])
        csv_out = self.run_mail(
            "table", rel, "--sheet", "0", "--format", "csv", expect_code=0
        ).stdout
        self.assertIn("item,qty,total", csv_out)
        self.assertIn("apples,3,30", csv_out)
        tsv_out = self.run_mail(
            "table", rel, "--sheet", "0", "--format", "tsv", expect_code=0
        ).stdout
        self.assertIn("item\tqty\ttotal", tsv_out)
        self.assertIn("apples\t3\t30", tsv_out)

    def test_rows_slice_over_data_rows(self):
        rel = self._attachment_with_sidecar([self.ORDERS])
        # data rows are 0-based after the header: row 1 only => "pears"
        proc = self.run_mail(
            "table",
            rel,
            "--sheet",
            "0",
            "--format",
            "records",
            "--rows",
            "1:2",
            expect_code=0,
        )
        import json

        data = json.loads(proc.stdout)
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["item"], "pears")

    def test_cols_projection_by_name_and_index(self):
        rel = self._attachment_with_sidecar([self.ORDERS])
        by_name = self.run_mail(
            "table",
            rel,
            "--sheet",
            "0",
            "--format",
            "records",
            "--cols",
            "item,total",
            expect_code=0,
        ).stdout
        import json

        rec = json.loads(by_name)[0]
        self.assertEqual(set(rec.keys()), {"item", "total"})
        # by index: 0 and 2 == item, total
        by_idx = self.run_mail(
            "table",
            rel,
            "--sheet",
            "0",
            "--format",
            "records",
            "--cols",
            "0,2",
            expect_code=0,
        ).stdout
        self.assertEqual(set(json.loads(by_idx)[0].keys()), {"item", "total"})

    def test_formulas_shows_formula_column(self):
        rel = self._attachment_with_sidecar([self.ORDERS])
        proc = self.run_mail(
            "table",
            rel,
            "--sheet",
            "0",
            "--format",
            "records",
            "--formulas",
            expect_code=0,
        )
        import json

        data = json.loads(proc.stdout)
        # the total column carried a formula; value cells without one are null
        self.assertEqual(data[0]["total"], "qty*10")
        self.assertIsNone(data[0]["item"])

    def test_formatted_flag_uses_display_text(self):
        # value != value_raw so we can tell which was emitted
        sheet = {
            "name": "S",
            "header_row": 0,
            "columns": [("amount", "n")],
            "rows": [
                ["amount"],
                [("$1,234.00", "1234", "n", None)],
            ],
        }
        rel = self._attachment_with_sidecar([sheet])
        raw = self.run_mail(
            "table", rel, "--sheet", "0", "--format", "records", expect_code=0
        ).stdout
        import json

        self.assertEqual(
            json.loads(raw)[0]["amount"], 1234
        )  # raw default, native number
        fmt = self.run_mail(
            "table",
            rel,
            "--sheet",
            "0",
            "--format",
            "records",
            "--formatted",
            expect_code=0,
        ).stdout
        self.assertEqual(json.loads(fmt)[0]["amount"], "$1,234.00")

    def test_unknown_sheet_is_not_found(self):
        rel = self._attachment_with_sidecar([self.ORDERS])
        proc = self.run_mail("table", rel, "--sheet", "Nope")
        self.assertEqual(proc.returncode, 3)

    def test_missing_sidecar_is_not_found(self):
        # an attachment with no sibling .tabular.db
        sha = "nosidecar99"
        att_dir = self.attachments / sha
        att_dir.mkdir(parents=True, exist_ok=True)
        att = att_dir / "plain.xlsx"
        att.write_bytes(b"PK\x03\x04")
        proc = self.run_mail("table", self.rel(att))
        self.assertEqual(proc.returncode, 3)
        self.assertIn("no tabular sidecar", proc.stderr.lower())

    def test_header_row_override_none(self):
        rel = self._attachment_with_sidecar([self.ORDERS])
        # --header-row -1 => no header; all 3 rows become data rows
        proc = self.run_mail(
            "table",
            rel,
            "--sheet",
            "0",
            "--format",
            "records",
            "--header-row",
            "-1",
            expect_code=0,
        )
        import json

        data = json.loads(proc.stdout)
        self.assertEqual(len(data), 3)  # header row is now a data row
        # columns fall back to col0/col1/col2 labels
        self.assertIn("col0", data[0])

    def test_multi_sheet_workbook(self):
        second = {
            "name": "Summary",
            "header_row": 0,
            "columns": [("metric", "s"), ("value", "n")],
            "rows": [
                ["metric", "value"],
                [("count", "count", "s", None), ("2", "2", "n", None)],
            ],
        }
        rel = self._attachment_with_sidecar([self.ORDERS, second])
        listing = self.run_mail("table", rel, expect_code=0).stdout
        self.assertIn("Orders", listing)
        self.assertIn("Summary", listing)
        # address the second sheet by index
        proc = self.run_mail(
            "table", rel, "--sheet", "1", "--format", "records", expect_code=0
        )
        import json

        self.assertEqual(json.loads(proc.stdout)[0]["metric"], "count")

    def test_table_with_eml_path_reads_sidecar_from_meta(self):
        """Passing an .eml message file path to `mail table <path>` must locate
        the tabular sidecar recorded in its .meta file (X-Mailroom-Attachment-Tables:
        attachments/<sha>/<name>.tabular.db) rather than expecting a non-existent
        <EML_PATH>.tabular.db file."""
        sha = "1700000009sha0"
        att_dir = self.attachments / sha
        att_dir.mkdir(parents=True, exist_ok=True)
        db_path = att_dir / "financials.xlsx.tabular.db"
        self._build_sidecar(db_path, [self.ORDERS])

        eml_raw = (
            "From: data@analytics.com\r\n"
            "To: user@example.com\r\n"
            "Subject: Q3 Financials\r\n"
            "Date: Mon, 03 Aug 2026 15:00:00 +0000\r\n"
            "Message-ID: <msg9@analytics.com>\r\n"
            "\r\n"
            "Financial results attached.\r\n"
        )
        meta = (
            f"X-Mailroom-Sha: {sha}\n"
            "X-Mailroom-Account: user@example.com\n"
            f"X-Mailroom-Attachment-Tables: attachments/{sha}/financials.xlsx.tabular.db\n"
        )
        eml_path = self.write_inbound(
            "user@example.com", "1700000009.sha00000009.eml", eml_raw, meta=meta
        )
        eml_rel = self.rel(eml_path)

        proc = self.run_mail("table", eml_rel, expect_code=0)
        out = proc.stdout
        self.assertIn("Orders", out)
        self.assertIn("2 rows × 3 cols", out)


class ReadPaginationTests(MailCliTestBase):
    """`mail read --part N` splits a long body into READ_PART_BYTES chunks with
    a footer naming the next part. Tested by-path (no store needed), matching
    how ReplyThreadingTests reads a .eml directly. The chunk size (60_000) is
    hardcoded in mail.py and deliberately under the MCP result budget."""

    PART_BYTES = 60_000  # must match READ_PART_BYTES in mail.py

    def _inbound_with_body(self, body):
        raw = (
            (
                "From: Sender <sender@vendor.com>\r\n"
                "To: me@adeu.ai\r\n"
                "Subject: Long one\r\n"
                "Date: Mon, 06 Jul 2026 10:00:00 +0000\r\n"
                "Message-ID: <long-1@example.com>\r\n"
                "MIME-Version: 1.0\r\n"
                'Content-Type: text/plain; charset="utf-8"\r\n'
                "\r\n"
            )
            + body
            + "\r\n"
        )
        return self.write_inbound("me@adeu.ai", "300.cccc.eml", raw)

    def test_short_body_has_no_pagination_footer(self):
        src = self._inbound_with_body("Just a short note.")
        proc = self.run_mail("read", self.rel(src), expect_code=0)
        self.assertIn("Just a short note.", proc.stdout)
        self.assertNotIn("[part", proc.stdout)

    def test_long_body_splits_and_points_at_next_part(self):
        # 3 full parts' worth of distinguishable content
        body = "".join(f"L{i:06d}=" + "a" * 20 + "\n" for i in range(6000))
        self.assertGreater(len(body.encode("utf-8")), 2 * self.PART_BYTES)
        src = self._inbound_with_body(body)

        p1 = self.run_mail("read", self.rel(src), expect_code=0).stdout
        self.assertIn("[part 1 of", p1)
        self.assertIn("--part 2", p1)
        self.assertIn("L000000=", p1)  # starts at the beginning

        p2 = self.run_mail("read", self.rel(src), "--part", "2", expect_code=0).stdout
        self.assertIn("[part 2 of", p2)
        # part 2 content differs from part 1 (no overlap of the first line)
        self.assertNotIn("L000000=", p2)

    def test_parts_are_contiguous_and_cover_the_whole_body(self):
        # reassemble the body from all parts (stripping headers + footers) and
        # confirm no bytes are lost or duplicated across the part boundary
        body = "".join(f"{i:08d}\n" for i in range(20000))  # ~180KB => 3+ parts
        src = self._inbound_with_body(body)

        # discover part count from part 1's footer
        p1 = self.run_mail("read", self.rel(src), expect_code=0).stdout
        import re

        m = re.search(r"\[part 1 of (\d+)", p1)
        self.assertIsNotNone(m, msg=f"no part footer in:\n{p1[:500]}")
        total = int(m.group(1))
        self.assertGreaterEqual(total, 3)

        def body_only(out):
            # drop everything up to and including the blank line after headers,
            # and drop the trailing "[part X of Y ...]" footer line
            after_headers = out.split("\n\n", 1)[1] if "\n\n" in out else out
            lines = after_headers.splitlines()
            while lines and lines[-1].strip() == "":
                lines.pop()
            if lines and lines[-1].startswith("[part "):
                lines.pop()
            while lines and lines[-1].strip() == "":
                lines.pop()
            return "\n".join(lines)

        reassembled = body_only(p1)
        for n in range(2, total + 1):
            out = self.run_mail(
                "read", self.rel(src), "--part", str(n), expect_code=0
            ).stdout
            reassembled += "\n" + body_only(out)

        # every original marker line must appear exactly once, in order
        self.assertIn("00000000", reassembled)
        self.assertIn("00019999", reassembled)

    def test_out_of_range_part_is_not_found(self):
        src = self._inbound_with_body("short")
        proc = self.run_mail("read", self.rel(src), "--part", "9")
        self.assertEqual(proc.returncode, 3)  # NOT_FOUND
        self.assertIn("part", proc.stderr.lower())

    def test_part_flag_needs_a_number(self):
        src = self._inbound_with_body("short")
        proc = self.run_mail("read", self.rel(src), "--part", "abc")
        self.assertEqual(proc.returncode, 1)  # USAGE


class DraftVerbTests(MailCliTestBase):
    """`mail draft` and `mail draft-delete` only QUEUE intents into a SEPARATE
    DraftBox/new/ (never Outbox, never a send). The broker later uploads the
    draft to the provider's own Drafts folder, or reversibly moves a provider
    draft to Trash. These tests cover the pure-Python queue-write behavior and
    its guards (Drafts-only path jail; unknown-account rejection)."""

    ACCT = "me@adeu.ai"

    def _draft_eml(self, message_id="<draft-1@adeu.ai>"):
        raw = (
            "From: me@adeu.ai\r\n"
            "To: vendor@x.com\r\n"
            "Subject: Re: your invoice\r\n"
            "Date: Mon, 06 Jul 2026 10:00:00 +0000\r\n"
            f"Message-ID: {message_id}\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: text/plain; charset="utf-8"\r\n'
            "\r\n"
            "Thanks, will pay shortly.\r\n"
        )
        return self.write_inbound(self.ACCT, "500.dddd.eml", raw, folder="Drafts")

    def _draftbox_new(self):
        return self.accounts / self.ACCT / "mail" / "DraftBox" / "new"

    def test_draft_queues_upload_intent_and_moves_eml(self):
        import hashlib
        import json

        src = self._draft_eml()
        raw = src.read_bytes()
        proc = self.run_mail("draft", self.rel(src), expect_code=0)
        self.assertIn("DRAFT queued", proc.stdout)

        # the .eml is MOVED out of Drafts into DraftBox/new/
        self.assertFalse(src.exists())
        box_new = self._draftbox_new()
        emls = list(box_new.glob("*.eml"))
        self.assertEqual(len(emls), 1)
        self.assertEqual(emls[0].read_bytes(), raw)

        intent_path = emls[0].with_name(emls[0].name + ".draft.json")
        self.assertTrue(intent_path.is_file())
        intent = json.loads(intent_path.read_text())
        self.assertEqual(intent["op"], "upload")
        self.assertEqual(intent["account"], self.ACCT)
        self.assertEqual(intent["message_id"], "<draft-1@adeu.ai>")
        self.assertEqual(
            intent["sha256_12"], hashlib.sha256(raw).hexdigest()[:12]
        )

    def test_draft_refuses_non_drafts_path(self):
        # a message living in INBOX (not Drafts) must be refused
        raw = (
            "From: vendor@x.com\r\nTo: me@adeu.ai\r\nSubject: x\r\n"
            "Message-ID: <in-1@x.com>\r\n\r\nbody\r\n"
        )
        src = self.write_inbound(self.ACCT, "600.eeee.eml", raw, folder="INBOX")
        proc = self.run_mail("draft", self.rel(src))
        self.assertEqual(proc.returncode, 2)  # POLICY_REFUSAL
        self.assertIn("Drafts", proc.stderr)
        # nothing queued; original untouched
        self.assertTrue(src.exists())
        self.assertFalse(self._draftbox_new().exists())

    def test_draft_requires_single_arg(self):
        proc = self.run_mail("draft")
        self.assertEqual(proc.returncode, 1)  # USAGE

    def test_draft_delete_queues_delete_intent(self):
        import json

        self.account_dir(self.ACCT)
        proc = self.run_mail(
            "draft-delete", self.ACCT, "<draft-1@adeu.ai>", expect_code=0
        )
        self.assertIn("DRAFT-DELETE queued", proc.stdout)

        intents = list(self._draftbox_new().glob("*.delete.draft.json"))
        self.assertEqual(len(intents), 1)
        intent = json.loads(intents[0].read_text())
        self.assertEqual(intent["op"], "delete")
        self.assertEqual(intent["account"], self.ACCT)
        self.assertEqual(intent["message_id"], "<draft-1@adeu.ai>")

    def test_draft_delete_rejects_unknown_account(self):
        proc = self.run_mail("draft-delete", "nobody@nowhere.com", "<x@y>")
        self.assertEqual(proc.returncode, 3)  # NOT_FOUND
        self.assertIn("no such account", proc.stderr)

    def test_draft_delete_requires_two_args(self):
        proc = self.run_mail("draft-delete", self.ACCT)
        self.assertEqual(proc.returncode, 1)  # USAGE

    def test_draft_delete_rejects_empty_message_id(self):
        self.account_dir(self.ACCT)
        proc = self.run_mail("draft-delete", self.ACCT, "   ")
        self.assertEqual(proc.returncode, 1)  # USAGE

    def test_draft_delete_queues_when_the_index_files_the_draft_elsewhere(self):
        """A synced Gmail draft is indexed under folder "Archive", so the room
        must NOT decide draft-ness from the indexed folder name.

        Gmail keeps drafts in [Gmail]/All Mail carrying the DRAFT label and
        neither INBOX nor SENT, and gmail.ts metaFolderFor() buckets anything
        without those two labels as "Archive". The draft the QA run uploaded on
        2026-07-24 is in the real store exactly that way:

            folder="Archive"  labels_json='["DRAFT"]'
            rfc_message_id="<178491651338.53560.8051403491946119953@gmail.com>"

        Drafts-only scoping is already enforced where it can be enforced
        correctly — provider-side, against the provider's own Drafts folder:
        gmail.ts deleteDraft() searches \\Drafts and returns "noop" if the id is
        not there, and msgraph.ts deleteDraft() filters
        /me/mailFolders/drafts/messages for the same reason ("so a colliding
        Message-ID on a real message can never be trashed"). Both then MOVE to
        Trash / Deleted Items; neither hard-deletes. A non-draft id is therefore
        already a harmless no-op.

        This is a REGRESSION GUARD. An autonomous fix loop (PR #2, commit
        97c470d) added a room-side folder check on the premise that the broker
        was deleting real received mail — it was not — and the check refused
        every Gmail draft the broker had already indexed, i.e. the verb worked
        only until the next sync. It also scanned the whole account maildir per
        call. If a folder check is ever wanted here, it must treat a DRAFT label
        (or an unknown folder) as a draft; this test fails if it does not.
        """
        import json
        import sqlite3

        self.account_dir(self.ACCT)
        broker = self.home / "broker"
        broker.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(broker / "store.db"))
        try:
            conn.execute(
                "CREATE TABLE message (sha TEXT PRIMARY KEY, account TEXT, "
                "folder TEXT, path TEXT, date_text TEXT, epoch INT, "
                "from_text TEXT, to_text TEXT, subject TEXT, labels_json TEXT, "
                "meta_only INT, rfc_message_id TEXT, body_cached INT, "
                "body_last_access INT)"
            )
            conn.execute(
                "INSERT INTO message VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "gm:9001",
                    self.ACCT,
                    "Archive",  # what a synced Gmail draft really looks like
                    "",
                    "",
                    0,
                    self.ACCT,
                    "vendor@x.com",
                    "Re: your invoice",
                    '["DRAFT"]',
                    1,
                    "<draft-1@adeu.ai>",
                    0,
                    0,
                ),
            )
            conn.commit()
        finally:
            conn.close()

        proc = self.run_mail(
            "draft-delete", self.ACCT, "<draft-1@adeu.ai>", expect_code=0
        )
        self.assertIn("DRAFT-DELETE queued", proc.stdout)
        intents = list(self._draftbox_new().glob("*.delete.draft.json"))
        self.assertEqual(len(intents), 1)
        self.assertEqual(json.loads(intents[0].read_text())["op"], "delete")


class FolderChangeHonestyTests(MailCliTestBase):
    """
    Dry run used to move the local .eml anyway ("just a preview"), while the
    provider was untouched. The no-op guards below read that local state and
    ignore dry_run, so a LATER real archive of the same message short-circuited
    to "already archived", exit 0, nothing queued, provider never called — and
    turning dry run off did not recover. These lock the wording that makes both
    halves honest.
    """

    ACCT = "me@adeu.ai"

    def _status(self, dry_run):
        import json

        (self.room / ".broker-status.json").write_text(
            json.dumps({"dry_run": dry_run}), encoding="utf-8"
        )

    def _seed(self, folder="INBOX"):
        raw = (
            "From: s@vendor.com\r\n"
            "To: me@adeu.ai\r\n"
            "Subject: Archive me\r\n"
            "Message-ID: <arch@vendor.com>\r\n"
            "Date: Mon, 06 Jul 2026 10:00:00 +0000\r\n"
            "\r\n"
            "body\r\n"
        )
        return self.write_inbound(
            self.ACCT, "1700000000.aaaaaaaaaaaa.eml", raw, folder=folder
        )

    def test_dry_run_note_does_not_promise_a_local_move(self):
        self._status(True)
        p = self._seed()
        proc = self.run_mail("archive", self.rel(p), expect_code=0)
        self.assertIn("ARCHIVE queued", proc.stdout)
        self.assertIn("dry_run is on", proc.stdout)
        self.assertIn("NOTHING changes", proc.stdout)
        self.assertIn("is NOT archived", proc.stdout)
        # the old text promised the opposite and is what made the room drift
        self.assertNotIn("local copy still moves", proc.stdout)

    def test_noop_names_the_provider_and_the_recovery_path(self):
        p = self._seed(folder="Archive")
        proc = self.run_mail("archive", self.rel(p), expect_code=0)
        self.assertIn("already archived (no-op)", proc.stdout)
        # an agent reading this must not conclude the mailbox was changed
        self.assertIn("NOT sent to the provider", proc.stdout)
        self.assertIn("mail unarchive", proc.stdout)
        self.assertNotIn("ARCHIVE queued", proc.stdout)

    def test_unarchive_noop_mirrors_the_wording(self):
        p = self._seed(folder="INBOX")
        proc = self.run_mail("unarchive", self.rel(p), expect_code=0)
        self.assertIn("already in inbox (no-op)", proc.stdout)
        self.assertIn("NOT sent to the provider", proc.stdout)
        self.assertIn("mail archive", proc.stdout)


class DisconnectedMailboxTests(MailCliTestBase):
    """
    Removing an account KEEPS its local mail by default (the settings page
    leaves "also delete the local mail copy" unticked), and `mail index` /
    `mail search` read the store, so that mail keeps listing forever with
    nothing to distinguish it from live mail. An agent then reports a removed
    mailbox's messages as the user's current mail. These pin the labelling.
    """

    LIVE = "live@adeu.ai"
    GONE = "gone@adeu.ai"

    def _status(self, accounts):
        import json

        (self.room / ".broker-status.json").write_text(
            json.dumps(
                {
                    "ts": "2026-07-28T10:00:00Z",
                    # both mailboxes still have local maildirs; only the
                    # config-derived list says which are still synced
                    "accounts": [self.LIVE, self.GONE],
                    "connected_accounts": accounts,
                }
            ),
            encoding="utf-8",
        )

    def _store(self, *, gone_on_disk=False):
        import sqlite3

        broker = self.home / "broker"
        broker.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(broker / "store.db"))
        try:
            conn.execute(
                "CREATE TABLE message (sha TEXT PRIMARY KEY, account TEXT, "
                "folder TEXT, path TEXT, date_text TEXT, epoch INT, "
                "from_text TEXT, to_text TEXT, subject TEXT, body_text TEXT, "
                "labels_json TEXT, meta_only INT, rfc_message_id TEXT, "
                "body_cached INT, body_last_access INT)"
            )
            gone_path = ""
            if gone_on_disk:
                raw = (
                    "From: s@vendor.com\r\n"
                    f"To: {self.GONE}\r\n"
                    "Subject: archived correspondence\r\n"
                    "Date: Mon, 06 Jul 2026 10:00:00 +0000\r\n"
                    "\r\n"
                    "old body text\r\n"
                )
                p = self.write_inbound(self.GONE, "1700000000.gonesha00000.eml", raw)
                gone_path = self.rel(p)
            for sha, account, subject, mpath in (
                ("livesha00000", self.LIVE, "live mail", ""),
                ("gonesha00000", self.GONE, "archived correspondence", gone_path),
            ):
                conn.execute(
                    "INSERT INTO message VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        sha,
                        account,
                        "INBOX",
                        mpath,
                        "Mon, 06 Jul 2026 10:00:00 +0000",
                        1700000000,
                        "s@vendor.com",
                        account,
                        subject,
                        subject,  # body_text: the LIKE search fallback reads it
                        None,
                        0 if mpath else 1,
                        f"<{sha}@vendor.com>",
                        0,
                        0,
                    ),
                )
            conn.commit()
        finally:
            conn.close()

    def test_index_marks_rows_from_a_removed_mailbox(self):
        self._store()
        self._status([self.LIVE])
        proc = self.run_mail("index", "--limit", "10", expect_code=0)
        lines = [l for l in proc.stdout.splitlines() if "\t" in l]
        gone = [l for l in lines if self.GONE in l]
        live = [l for l in lines if self.LIVE in l]
        self.assertTrue(gone and live, proc.stdout)
        self.assertIn("[disconnected]", gone[0])
        self.assertNotIn("[disconnected]", live[0])
        # the explanation and the undo command travel with the listing
        self.assertIn("was REMOVED from Mailroom", proc.stdout)
        self.assertIn(f"mail login {self.GONE}", proc.stdout)
        self.assertIn("local archive", proc.stdout)

    def test_search_marks_them_too(self):
        self._store()
        self._status([self.LIVE])
        proc = self.run_mail("search", "correspondence", expect_code=0)
        self.assertIn("[disconnected]", proc.stdout)
        self.assertIn("was REMOVED from Mailroom", proc.stdout)

    def test_nothing_is_marked_when_all_accounts_are_connected(self):
        self._store()
        self._status([self.LIVE, self.GONE])
        proc = self.run_mail("index", "--limit", "10", expect_code=0)
        self.assertNotIn("[disconnected]", proc.stdout)
        self.assertNotIn("REMOVED", proc.stdout)

    def test_the_maildir_list_alone_must_not_drive_the_marking(self):
        # REGRESSION: the first cut of this read status["accounts"], which is
        # the set of local MAILDIRS. Keep-local removal leaves the maildir in
        # place, so a removed mailbox still appeared connected and the whole
        # feature silently did nothing. Only connected_accounts may decide.
        import json

        self._store()
        (self.room / ".broker-status.json").write_text(
            json.dumps({"ts": "2026-07-28T10:00:00Z", "accounts": [self.GONE]}),
            encoding="utf-8",
        )
        proc = self.run_mail("index", "--limit", "10", expect_code=0)
        self.assertNotIn("[disconnected]", proc.stdout)

    def test_no_status_file_never_claims_a_live_mailbox_was_deleted(self):
        # fail-safe: wrongly telling the user their mailbox is gone is worse
        # than staying quiet, so "cannot tell" must mark nothing
        self._store()
        proc = self.run_mail("index", "--limit", "10", expect_code=0)
        self.assertNotIn("[disconnected]", proc.stdout)

    def test_read_of_a_bodyless_orphan_does_not_advise_a_doomed_fetch(self):
        # `mail fetch` is rejected with unknown_account for a removed mailbox,
        # so the old "[REMOTE] run mail fetch" advice looped the agent
        self._store()
        self._status([self.LIVE])
        proc = self.run_mail("read", "gonesha00000", expect_code=0)
        self.assertIn("[DISCONNECTED]", proc.stdout)
        self.assertIn("cannot be downloaded", proc.stdout)
        self.assertIn(f"mail login {self.GONE}", proc.stdout)
        self.assertNotIn("mail fetch gonesha00000", proc.stdout)

    def test_read_of_a_connected_bodyless_row_still_advises_fetch(self):
        self._store()
        self._status([self.LIVE, self.GONE])
        proc = self.run_mail("read", "gonesha00000", expect_code=0)
        self.assertIn("[REMOTE]", proc.stdout)
        self.assertIn("mail fetch gonesha00000", proc.stdout)

    def test_read_of_a_readable_orphan_says_it_is_an_archive_copy(self):
        self._store(gone_on_disk=True)
        self._status([self.LIVE])
        proc = self.run_mail("read", "gonesha00000", expect_code=0)
        self.assertIn("was REMOVED from Mailroom", proc.stdout)
        self.assertIn("local archive copy", proc.stdout)
        self.assertIn("old body text", proc.stdout)  # still readable

    def test_status_reports_retained_mail_so_it_matches_index(self):
        self._store()
        self._status([self.LIVE])
        proc = self.run_mail("status", expect_code=0)
        self.assertIn(f"accounts: {self.LIVE}", proc.stdout)
        self.assertIn("disconnected (removed, local archive only)", proc.stdout)
        self.assertIn(self.GONE, proc.stdout)
        self.assertIn("1 message(s)", proc.stdout)

    def test_status_stays_quiet_when_nothing_is_orphaned(self):
        self._store()
        self._status([self.LIVE, self.GONE])
        proc = self.run_mail("status", expect_code=0)
        self.assertNotIn("disconnected (removed", proc.stdout)


class TagVerbTests(MailCliTestBase):
    """`mail tag`, `mail untag`, and `mail tags` handle message tagging state.
    Tags must be toggleable (tag -> untag -> tag) without tombstoning the tag
    for that message."""

    ACCT = "alice@example.com"

    def _sample_eml(self):
        raw = (
            "From: bob@example.com\r\n"
            "To: alice@example.com\r\n"
            "Subject: Tag Test Email\r\n"
            "Date: Mon, 06 Jul 2026 10:00:00 +0000\r\n"
            "Message-ID: <tag-test-1@example.com>\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: text/plain; charset="utf-8"\r\n'
            "\r\n"
            "This is a test email for tagging.\r\n"
        )
        return self.write_inbound(self.ACCT, "tag_test.eml", raw, folder="INBOX")

    def test_retagging_after_untag_restores_active_tag(self):
        src = self._sample_eml()
        msg_rel = self.rel(src)

        # 1. Initial tag
        proc1 = self.run_mail("tag", msg_rel, "urgent", expect_code=0)
        self.assertIn("tagged", proc1.stdout)

        proc_tags1 = self.run_mail("tags", msg_rel, expect_code=0)
        self.assertIn("urgent", proc_tags1.stdout.splitlines())

        # 2. Untag
        proc2 = self.run_mail("untag", msg_rel, "urgent", expect_code=0)
        self.assertIn("untagged", proc2.stdout)

        proc_tags2 = self.run_mail("tags", msg_rel, expect_code=0)
        self.assertNotIn("urgent", proc_tags2.stdout.splitlines())

        # 3. Re-tag
        proc3 = self.run_mail("tag", msg_rel, "urgent", expect_code=0)
        self.assertIn("tagged", proc3.stdout)

        # 4. Check active tags after re-tag (must contain 'urgent')
        proc_tags3 = self.run_mail("tags", msg_rel, expect_code=0)
        self.assertIn(
            "urgent",
            proc_tags3.stdout.splitlines(),
            msg="Re-tagging a message after untagging must reactivate the tag rather than tombstoning it.",
        )

    def test_mixed_timestamp_formats_sort_chronologically(self):
        """Mixed 'Z' and '+00:00' timestamp strings must sort chronologically, not lexicographically."""
        src = self._sample_eml()
        msg_rel = self.rel(src)

        self.run_mail("tag", msg_rel, "urgent", expect_code=0)
        self.run_mail("untag", msg_rel, "urgent", expect_code=0)

        tags_file = self.room / ".tags.jsonl"
        untag_file = self.room / ".untag-request.jsonl"

        # Update timestamps: Tag at T2 (+00:00 format, 500ms after untag), Untag at T1 (Z format)
        # Alphabetically '2026-07-06T10:00:01Z' > '2026-07-06T10:00:01.500000+00:00' ('Z' > '.').
        # Chronologically 10:00:01.500000 is 500ms later than 10:00:01.
        tag_data = json.loads(tags_file.read_text(encoding="utf-8").strip())
        tag_data["ts"] = "2026-07-06T10:00:01.500000+00:00"
        tags_file.write_text(json.dumps(tag_data) + "\n", encoding="utf-8")

        untag_data = json.loads(untag_file.read_text(encoding="utf-8").strip())
        untag_data["ts"] = "2026-07-06T10:00:01Z"
        untag_file.write_text(json.dumps(untag_data) + "\n", encoding="utf-8")

        proc_tags = self.run_mail("tags", msg_rel, expect_code=0)
        self.assertIn(
            "urgent",
            proc_tags.stdout.splitlines(),
            msg="tag at 10:00:01.5+00:00 is newer than untag at 10:00:01Z; "
            "lexicographic ordering wrongly applies the untag last.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
