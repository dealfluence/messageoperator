# Contributor & Agent Guide — Message Operator

Node 24 (`.node-version`, `engines: >=24`; `node:sqlite` needs 22.13+). Python 3 + [uv](https://docs.astral.sh/uv/) are required — part of `npm test` is a Python suite.

## Commands

| task                | command                                                           |
| ------------------- | ----------------------------------------------------------------- |
| full gate           | `npm run lint` → `npm run typecheck` → `npm test` (~70s)          |
| one TS test         | `npx vitest run test/config.test.ts`                              |
| one ingest test     | `node --experimental-sqlite --test ingest/test/store.test.mjs`    |
| Python CLI tests    | `uv run python -m unittest discover -s test -p "test_mail_py.py"` |
| format (CI parity)  | `npx prettier --check .` / `npm run format` to fix                |
| fast build          | `node build.mjs --no-bundle` (~3s)                                |
| full build + bundle | `npm run build`, then `npm run pack:mcpb`                         |

- `npm test` = `vitest run` **+** `test:ingest` (node:sqlite) **+** `test:mail` (Python/uv). Vitest alone is not the suite.
- Prefer `node build.mjs --no-bundle` while iterating: plain `npm run build` also runs `npm ci --omit=dev` inside `bundle/`, which is slow and only needed for packing.
- `npm run typecheck` is **two** tsc projects: root (`src/` + `test/`) and `tsc -p ui` (DOM libs).
- The pre-commit hook runs `lint-staged && npm run typecheck && npm test` — the whole suite, every commit.
- Commits are manual: **ask the user to commit/push**, do not do it unprompted.

## Architecture

Room/broker split over a **filesystem contract** (see `AI_CONTEXT.md`, `README.md`).

- `src/cli.ts` — the only entrypoint: `serve | broker [--once] | login | set-gmail-password`. The bundle runs `dist/cli.js serve`. Module scope is Node built-ins only and every project module is imported dynamically, so `serve` reaches the MCP handshake before touching the provider dependency graph. Keep it that way.
- `src/server.ts` — MCP stdio server, path-jailed to `room/`. Exposes exactly four VM tools: `messageoperator_bash`, `messageoperator_view`, `messageoperator_create_file`, `messageoperator_str_replace`. No background service and no login tool; the broker acts at tool-call boundaries.
- `src/broker.ts` — privileged: credentials, network sync, policy, audit.
- `src/room_assets/` — installed into the room by `layout.ts` (`mail.py` → `<room>/bin/mail.py`, `SKILL.md` → `<room>/skills/SKILL.md`). `mail.py` is stdlib-only Python 3 (deployment machines guarantee a system Python but no invokable Node) and has no TS harness — it is covered by `test/test_mail_py.py`.
- `ui/<name>/` — `<name>.ts` + `<name>.html` are bundled into one self-contained `dist/ui/<name>.html`. The host CSP blocks all external origins, so scripts/styles/fonts must be inlined; the template must contain `<!--__SCRIPT__-->` or the build throws.
- Env vars all use the `MESSAGEOPERATOR_` prefix (`src/env.ts`).

### Two separate SQLite stores — do not conflate

`src/db.ts` (broker, `broker/store.db`) and `ingest/src/db.mjs` (`~/messageoperator-ingest/store.db`) both use `node:sqlite` and both say `SCHEMA_VERSION = 2`, but the same-named tables (`message`, `tag`, `sync_state`) have **incompatible columns** and independent migrations. The broker keys `message` on `sha`; ingest keys on `UNIQUE(account, provider_msg_id)`. Never port a query between them.

### `ingest/` status

A tracked, plain-`.mjs` dev CLI of POC lineage (`src/db.ts:4`), **not shipped** in `bundle/`. No `src/` code imports it. It is still load-bearing, so do not delete or gitignore it casually:

- `package.json` `test:ingest` runs `ingest/test/*.test.mjs` as part of `npm test`;
- `test/secrets.test.ts` and `test/secrets_os.test.ts` import `../ingest/src/secrets.mjs`.

## What the toolchain does NOT check

- `tsconfig.json` includes only `src/**/*.ts` and `test/**/*.ts`, and sets `allowJs: false` → `ingest/**/*.mjs` and `build.mjs` are **never typechecked**. (`ingest/src/secrets.d.mts` exists solely so root tests can import the `.mjs`.)
- `eslint.config.mjs` matches `**/*.ts` only → **no `.mjs` file is linted.**
- So `ingest/` is guarded only by its own `node:test` suite and Prettier. Be correspondingly careful there.
- `@typescript-eslint/no-non-null-assertion` is an **error** in `src/`, relaxed only for `test/**`. `noUncheckedIndexedAccess` is on.

## Secrets invariants

All secret storage goes through `src/secrets.ts`: one master key in the OS store (macOS Keychain / Windows DPAPI / `0600` file) unlocking AES-256-GCM files.

- Never add a native dependency (the `.mcpb` bundle must stay prebuild-free), never write a secret in plain text, never pass one in argv, and **never replace a master key that exists but cannot be read**.
- `ingest/src/secrets.mjs` is a read-only synchronous mirror of the same format. `test/secrets.test.ts` (`describe("ingest mirror")`) pins them by round-trip: the TS side encrypts, the `.mjs` side must decrypt. Change one, run that test.
- `test/setup.ts` forces the **file** backend process-wide so no test can touch a real keychain. `test/secrets_os.test.ts` is the only suite that hits the real OS store — opt-in via `MESSAGEOPERATOR_SECRET_IT=1`, run by CI on macOS + Windows.

## Docs are enforced by tests

`test/docs_contract.test.ts` treats `src/room_assets/SKILL.md` (the room's only manual) as code:

- Adding a folder to `SKIP_FOLDERS` in `src/msgraph.ts` **fails the suite** until you update that test's `DISCLOSURE` map and disclose the exclusion in SKILL.md.
- Every `ENTIRE`/`FULL`/`whole mailbox` claim must carry its qualifier **in the same paragraph** — a carve-out further down does not satisfy the test.
- SKILL.md must state that simulated (dry-run) sends still count toward `max_sends_per_hour`.
- `LICENSE` must contain `Message Operator version <package.json version>`.

## Versioning

The version is hardcoded in four places: `package.json`, `manifest.json`, `src/server.ts` (MCP handshake), and `LICENSE`. Only the LICENSE↔package.json pair is test-guarded. Use the script:

```
uv run python scripts/bump.py [major|minor|patch|X.Y.Z] [--dry-run]
```

It updates all four plus `package-lock.json`. Do not bump by hand.

## Testing gotchas

- `test/test_mail_py.py` builds throwaway rooms under `test/.scratch/`, deliberately **not** `tempfile.gettempdir()`: `/tmp/` is a sandbox-VM marker in `mail.py`'s bridge detector, so a tempdir-based room makes every import/export exit 2 on Linux CI. Do not "fix" it to use `tempfile`.
- Test helpers live in `test/helpers.ts` (`makeLayout`, `seedGmailPassword`, `queueSend`, `sampleEml`, …). Seed credentials through those, not raw `fs.writeFileSync` — they go through the real encrypted-volume path.
- Vitest timeouts are raised to 30s because broker cycles do real filesystem work.

## Conventions & gotchas

- Working tree is LF, but local git may have `core.autocrlf=true`. If `npx prettier --check .` suddenly flags whole files on Windows, it is line endings, not content — `npx prettier --write <file>`. CI checks formatting on Linux only for this reason. `.gitattributes` pins `.husky/*` to LF because the hooks break on CRLF.
- `dev-sync.sh` (macOS) pushes a fresh build into the **installed** Claude Desktop extension in place, and also refreshes the live `room/bin/mail.py`. Claude Desktop must be fully quit (Cmd-Q) and reopened — MCP servers only restart on app relaunch.
- Never commit credentials, key material, real mailbox dumps (`*.eml`), or local databases (`*.db`).
- Machine-local agent tooling is deliberately gitignored: `.kilo/`, `.claude/`, `graphify-out/`, `.ralph.json`. `.claude/` is also excluded from ESLint and Prettier because it holds full repo copies.
