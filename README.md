# Message Operator : email as a small computer

The TypeScript Message Operator server, served as an **MCPB bundle** (`.mcpb`, one-click install).

The architecture is a filesystem with Maildir layout and programmable command line tools.
Message Operator exploits the fact that LLMs are highly trained to work with a command line bash interface.
And thus we make everything look to it like 1990s unix.

The system can handle multiple email accounts from Google and Microsoft. This is not a sandbox but a workspace.
It is open to the host system and can manipulate data in there also.

## Development (any platform)

```
git clone https://github.com/dealfluence/messageoperator.git
cd messageoperator
npm install
```

The development environment requires **Node.js 24** (or 22.13+) and the **[uv](https://docs.astral.sh/uv/)** Python package manager to execute the Python-side unit and integration tests.

```
# Run the full test suite (TypeScript unit/integration tests + Python unittest CLI tests via uv)
npm test

# Run TypeScript check
npm run typecheck
```

Windows dev works (bash_tool finds Git-Bash); macOS is the deployment
target. Dev/server Node 24 recommended (`node:sqlite`; 22.13+ minimum,
FTS5 optional); the in-room CLI needs only a system Python 3 and **uv** installed.

## Build the MCPB bundle

```
npm run build                          # dist/ + bundle/ (prod node_modules)
npx mcpb pack bundle messageoperator.mcpb     # or: npm run pack:mcpb
```

Open the `.mcpb` with Claude Desktop on macOS to install. The extension
settings hold only policy and the Azure client ID; mailboxes are connected
in-chat with `mail login <address>`. State lives under `~/messageoperator/`.

## Azure app registration (Microsoft accounts)

1. portal.azure.com → Entra ID → App registrations → New: supported account
   types "any org directory + personal accounts".
2. Add platform **Mobile and desktop applications** with redirect URI
   `http://localhost` (loopback; any port is accepted at runtime).
3. API permissions → Microsoft Graph → Delegated: `Mail.ReadWrite`,
   `Mail.Send`.
4. Put the Application (client) ID in the extension settings. Sign-in
   happens in the browser on first use : no console needed.

## Config beyond the settings pane

`~/messageoperator/broker/config.json`:

```json
{
  "dry_run": true,
  "serve_broker": "boundary",
  "pull_interval_seconds": 30,
  "body_cache_mb": 50,
  "accounts": [
    { "provider": "gmail", "address": "you@gmail.com" },
    { "provider": "gmail", "address": "second@gmail.com" },
    {
      "provider": "microsoft",
      "address": "you@outlook.com",
      "client_id": "..."
    }
  ],
  "policy": {
    "allowed_recipient_domains": [],
    "max_sends_per_hour": 5,
    "max_attachment_mb": 10
  }
}
```

Settings-pane values merge in (and win for `dry_run`). Extra Gmail accounts
store their app passwords per address:
`node dist/cli.js set-gmail-password --account second@gmail.com`.

## Secrets at rest

One master key in the OS credential store; everything else in AES-256-GCM
files it unlocks. No secret is kept in plain text, and no native module is used
to manage them — the bundle stays prebuild-free (see `src/secrets.ts`).

| file under `broker/credentials/` | holds                                   |
| -------------------------------- | --------------------------------------- |
| `secrets.json`                   | Gmail app passwords (one flat JSON map) |
| `msal_token_cache.enc`           | the Microsoft/MSAL token cache          |

Both use the same envelope: `{ "iv", "authTag", "data" }`, hex, AES-256-GCM
with a fresh 96-bit IV per write and the file's own basename authenticated as
additional data. Where the 256-bit master key lives:

| platform     | master key                                                      |
| ------------ | --------------------------------------------------------------- |
| macOS        | login Keychain, service `messageoperator`, account `master-key` |
| Windows      | DPAPI (`CurrentUser`) blob at `master_key.dpapi`                |
| Linux/Docker | `master_key`, mode `0600`                                       |

The key never appears in a process listing: on macOS the `add-generic-password`
command is fed to `security -i` on **stdin**, and on Windows the payload is
piped to PowerShell's `[System.Security.Cryptography.ProtectedData]`. A key is
only ever created when none exists — if one is present but unreadable (locked
keychain, denied ACL), the app reads nothing and **writes nothing** rather than
replacing it, because that key is the only thing standing between a restart and
re-authenticating every mailbox.

There is deliberately no Linux Secret Service client: every pure-JS D-Bus
library needs a native addon for abstract sockets, which this bundle cannot
build, and containers have no keyring anyway.

Secrets left in the open by an earlier version — a plaintext file, a
SecureString clixml, a per-address keychain item or DPAPI blob — are moved into
the volume the first time they are read, and the old copy is deleted. Set
`MESSAGEOPERATOR_SECRET_BACKEND=file` to force the file backend (containers,
CI); the test suite pins it so no test can touch a real keychain, and
`MESSAGEOPERATOR_SECRET_IT=1` runs the one suite that deliberately does.

## CLI (dev/terminal conveniences)

```
node dist/cli.js serve                 # what the bundle runs (MCP stdio)
node dist/cli.js broker --once         # one standalone broker cycle
node dist/cli.js login [--account a@b] # browser sign-in from a terminal
node dist/cli.js set-gmail-password --account a@gmail.com
```

Everything the CLI does also happens lazily through the extension settings
and `mail login`; the CLI is optional.

## License

This project is licensed under the Business Source License 1.1 (BSL 1.1),
a **source-available, not open-source** license: non-production use is free,
production use requires a commercial license until the Change Date
(2030-08-03), after which the code converts to the Apache License,
Version 2.0. See [LICENSE](LICENSE) for the exact terms.

Copyright (c) 2026 Dealfluence Oy. "Message Operator" is developed by
Team Adeu; commercial licensing: contact@dealfluence.com.
