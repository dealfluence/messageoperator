#!/usr/bin/env bash
# dev-sync.sh — build Message Operator and push the fresh code into the
# installed Claude Desktop extension IN PLACE, so terminal edits become
# testable in Desktop without a full repack/reinstall (settings + userConfig
# untouched).
#
#   ./dev-sync.sh            build + sync dist/ AND node_modules/
#   ./dev-sync.sh --fast     skip node_modules sync (only when you KNOW deps
#                            are unchanged — a dep skew crashes the server on
#                            boot with ERR_MODULE_NOT_FOUND, so default is safe)
#
# It never touches MESSAGEOPERATOR_HOME (your real mailboxes/accounts/store.db).
# After it runs, FULLY quit Claude Desktop (Cmd-Q) and reopen — MCP servers
# only restart on app relaunch.
set -euo pipefail

# Homebrew Node/Python aren't on the default PATH in a fresh shell.
export PATH="/opt/homebrew/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$HOME/Library/Application Support/Claude/Claude Extensions"
EXT="$EXT_ROOT/local.mcpb.team-adeu.messageoperator"
# pre-rename (≤0.6.0 "mailroom") extension id — detect so a stale install
# does not silently keep running old code next to the renamed one
OLD_EXT="$EXT_ROOT/local.mcpb.team-adeu.mailroom"

if [[ ! -d "$EXT" ]]; then
  echo "✗ installed extension not found at:" >&2
  echo "    $EXT" >&2
  if [[ -d "$OLD_EXT" ]]; then
    echo "  A pre-rename 'mailroom' extension is still installed at:" >&2
    echo "    $OLD_EXT" >&2
    echo "  Install messageoperator.mcpb in Claude Desktop, remove the old" >&2
    echo "  'Mailroom' extension there, then re-run." >&2
  else
    echo "  Install messageoperator.mcpb in Claude Desktop once, then re-run." >&2
  fi
  exit 1
fi

if [[ -d "$OLD_EXT" ]]; then
  echo "⚠ pre-rename 'mailroom' extension is ALSO still installed:" >&2
  echo "    $OLD_EXT" >&2
  echo "  Remove it in Claude Desktop's extension settings — two installed" >&2
  echo "  servers would race over the same state directory." >&2
fi

cd "$REPO"

echo "→ building (npm run build)…"
npm run build >/dev/null

echo "→ syncing dist/ into installed extension…"
rsync -a --delete "$REPO/bundle/dist/" "$EXT/dist/"

# node_modules is synced by DEFAULT. dist/ imports whatever the current source
# imports; if a dependency was added since the extension was installed, the
# stale node_modules makes the server exit early on boot (ERR_MODULE_NOT_FOUND).
# rsync is incremental, so after the first run this is cheap. Use --fast to skip
# only when you are certain deps are unchanged.
if [[ "${1:-}" == "--fast" ]]; then
  echo "→ skipping node_modules sync (--fast)"
else
  echo "→ syncing node_modules/ …"
  rsync -a --delete "$REPO/bundle/node_modules/" "$EXT/node_modules/"
  cp -f "$REPO/bundle/package.json" "$EXT/package.json"
fi

# The broker copies room_assets/mail.py into <state home>/room/bin/mail.py at
# server boot (layout.ts ensureRoom), and THAT copy is what actually runs when
# you invoke `mail` in a chat. Refreshing dist/ alone is not enough: without a
# full Desktop restart the running broker keeps the old room copy. So push the
# fresh mail.py straight into the live room too — the broker overwrites it with
# an identical file on next boot, so this is always safe.
# State home: canonical env, then legacy env, then the same directory probe
# layout.ts stateHome() uses.
MO_HOME="${MESSAGEOPERATOR_HOME:-${MAILROOM_HOME:-}}"
if [[ -z "$MO_HOME" ]]; then
  if [[ ! -d "$HOME/messageoperator" && -d "$HOME/mailroom" ]]; then
    MO_HOME="$HOME/mailroom"
  else
    MO_HOME="$HOME/messageoperator"
  fi
fi
ROOM_MAIL="$MO_HOME/room/bin/mail.py"
if [[ -f "$ROOM_MAIL" ]]; then
  cp -f "$REPO/bundle/dist/room_assets/mail.py" "$ROOM_MAIL"
  echo "→ refreshed live room copy: $ROOM_MAIL"
fi

# Verify the new build actually landed: the draft verbs are the freshest thing
# in the tree, so their presence is good proof the sync took.
ok=1
grep -q '"draft-delete"' "$EXT/dist/room_assets/mail.py" 2>/dev/null \
  && echo "✓ installed extension mail.py has the draft verbs" \
  || { echo "⚠ installed extension mail.py missing draft verbs" >&2; ok=0; }
if [[ -f "$ROOM_MAIL" ]]; then
  grep -q '"draft-delete"' "$ROOM_MAIL" 2>/dev/null \
    && echo "✓ live room mail.py has the draft verbs" \
    || { echo "⚠ live room mail.py missing draft verbs" >&2; ok=0; }
fi

if pgrep -x "Claude" >/dev/null 2>&1; then
  echo "⚠ Claude Desktop is RUNNING — fully quit it (Cmd-Q, not just the window)"
  echo "  and reopen so the messageoperator server reboots with the new code."
else
  echo "✓ Claude Desktop is not running — it will boot the new code on next launch."
fi

[[ "$ok" == 1 ]] && echo "done." || { echo "done WITH WARNINGS." >&2; exit 1; }
