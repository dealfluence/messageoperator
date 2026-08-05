#!/usr/bin/env python3
"""Bump the Message Operator version across every file that hardcodes it.

The version string lives in four places and only ONE pair is guarded by a test
(test/docs_contract.test.ts pins LICENSE against package.json). manifest.json
and src/server.ts have no test at all, so a hand bump silently ships an
MCPB whose advertised version disagrees with the server's MCP handshake.
This script is the single source of truth for that fan-out.

  uv run python scripts/bump.py              # minor (default)
  uv run python scripts/bump.py patch
  uv run python scripts/bump.py major
  uv run python scripts/bump.py 1.2.3        # exact
  uv run python scripts/bump.py patch --dry-run

Stdlib only, so `python3 scripts/bump.py` works without uv too.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# package.json is the reference: every other site is bumped to match it.
CANONICAL = REPO / "package.json"


def _sub_once(path, pattern, replacement, version):
    """Regex-replace in place, preserving the file's exact formatting."""
    if not path.exists():
        print(f"  ! skipping {path.name} (not found)")
        return False

    # newline="": read and write line endings VERBATIM. Python's default text
    # mode would translate every "\n" to "\r\n" on Windows, rewriting the line
    # endings of every file this script touches (a whole-file diff, and CRLF in
    # .husky/* would break the hooks).
    original = path.read_text(encoding="utf-8", newline="")
    updated, count = re.subn(pattern, replacement, original, count=1)

    if count == 0:
        print(f"  X {path.relative_to(REPO)}: pattern did not match -- "
              f"the version site moved, fix this script")
        sys.exit(1)
    if updated == original:
        print(f"  = {path.relative_to(REPO)} already at {version}")
        return False

    path.write_text(updated, encoding="utf-8", newline="")
    print(f"  + {path.relative_to(REPO)} -> {version}")
    return True


def bump_all(version, dry_run=False):
    """Apply `version` to all four sites. Returns True if anything changed."""
    # (path, pattern, replacement) -- each anchored tightly enough that it
    # cannot match a dependency version or an unrelated version-like string.
    sites = [
        # package.json: the top-level "version" key (first match; deps come later)
        (
            REPO / "package.json",
            r'("version"\s*:\s*)"[^"]+"',
            rf'\g<1>"{version}"',
        ),
        # manifest.json: the MCPB bundle version shown by the host
        (
            REPO / "manifest.json",
            r'("version"\s*:\s*)"[^"]+"',
            rf'\g<1>"{version}"',
        ),
        # src/server.ts: the version reported in the MCP initialize handshake
        (
            REPO / "src" / "server.ts",
            r'(\{\s*name:\s*"messageoperator",\s*version:\s*)"[^"]+"',
            rf'\g<1>"{version}"',
        ),
        # LICENSE: the BUSL "Licensed Work" line, pinned by docs_contract.test.ts
        (
            REPO / "LICENSE",
            r"(Licensed Work:\s+Message Operator version )\S+",
            rf"\g<1>{version}",
        ),
    ]

    if dry_run:
        print("  (dry run -- no files written)")
        for path, pattern, _ in sites:
            text = path.read_text(encoding="utf-8")
            found = re.search(pattern, text)
            print(f"  ? {path.relative_to(REPO)}: "
                  f"{'would update' if found else 'PATTERN MISS'}")
        return False

    # list(), not any(): a generator inside any() short-circuits on the first
    # True and would leave the remaining sites at the old version.
    results = [_sub_once(p, pat, rep, version) for p, pat, rep in sites]
    return any(results)


def current_version():
    return json.loads(CANONICAL.read_text(encoding="utf-8"))["version"]


def next_version(current, bump_type):
    bump_type = bump_type.lstrip("v")

    if re.fullmatch(r"\d+\.\d+\.\d+(-[\w.]+)?", bump_type):
        return bump_type

    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(-[\w.]+)?", current)
    if not match:
        print(f"X current version '{current}' is not X.Y.Z; pass an exact version")
        sys.exit(1)

    major, minor, patch = (int(match.group(i)) for i in (1, 2, 3))
    if bump_type == "major":
        return f"{major + 1}.0.0"
    if bump_type == "minor":
        return f"{major}.{minor + 1}.0"
    if bump_type == "patch":
        return f"{major}.{minor}.{patch + 1}"

    print(f"X '{bump_type}' is not major/minor/patch or an exact X.Y.Z version")
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Bump the Message Operator version across all four sites."
    )
    parser.add_argument(
        "bump_type",
        nargs="?",
        default="minor",
        help="major, minor, patch, or an exact version (e.g. 1.2.3). Default: minor.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing.",
    )
    args = parser.parse_args()

    current = current_version()
    target = next_version(current, args.bump_type)

    print(f"Message Operator {current} -> {target}\n")
    changed = bump_all(target, dry_run=args.dry_run)

    if args.dry_run:
        return

    if not changed:
        print(f"\nNothing to do -- already at {target}.")
        return

    # package.json's version is mirrored in package-lock.json (twice); npm ci
    # in CI fails if the lockfile is out of sync.
    print("\nSyncing package-lock.json...")
    result = subprocess.run(
        ["npm", "install", "--package-lock-only"],
        cwd=REPO,
        text=True,
        capture_output=True,
        shell=(sys.platform == "win32"),
    )
    if result.returncode != 0:
        print("  ! npm install --package-lock-only failed; run it by hand:")
        print(result.stderr.strip())
    else:
        print("  + package-lock.json")

    print("\nNext steps:")
    print("  1. npm test          # docs_contract.test.ts verifies LICENSE <-> package.json")
    print("  2. git diff          # review all five files")
    print(f'  3. git commit -am "chore(release): bump version to {target}"')


if __name__ == "__main__":
    main()
