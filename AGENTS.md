# Contributor & Agent Guide — Message Operator

## Stack & Environment

- **Node.js**: 24 recommended (22.13+ minimum required for `node:sqlite`).
- **TypeScript**: Bundled via `esbuild`.
- **In-Room CLI**: Asset at `src/room_assets/mail.py`, installed into `<room>/bin/mail.py` (Python 3 stdlib-only).
- **Python Tests**: Executed via `uv` (`uv run python -m unittest`).

## Common Development Commands

- `npm install` — Install dev & runtime dependencies.
- `npm test` — Run full test suite (Vitest `test/*.test.ts` + Node SQLite `ingest/test/*.test.mjs` + Python `test/test_mail_py.py`).
- `npm run typecheck` — TypeScript type validation across root and UI modules.
- `npm run lint` — ESLint validation.
- `npm run format` — Prettier formatting (`prettier --write .`).
- `npm run build` — Build `dist/` and assemble `bundle/`.
- `npm run pack:mcpb` — Package into `.mcpb` bundle.

## Codebase Architecture & Security Invariants

- **Room / Broker Split**: The broker holds all credentials and handles network sync; the room is path-jailed and isolated.
- **Secrets**: all secret storage goes through `src/secrets.ts` — one master key in the OS store (macOS Keychain / Windows DPAPI / `0600` file), every secret in an AES-256-GCM file it unlocks. Never add a native dependency for this (the `.mcpb` bundle must stay prebuild-free), never write a secret in plain text, never pass one in argv, and never replace a master key that exists but cannot be read. `ingest/src/secrets.mjs` is a read-only sync mirror of the same format; `test/secrets.test.ts` pins the two together and `test/secrets_os.test.ts` (opt-in, `MESSAGEOPERATOR_SECRET_IT=1`, run by CI on macOS + Windows) is the only test that touches a real credential store.
- See `AI_CONTEXT.md` for room/broker split details.
- See `README.md` for SQLite store and sync behavior details.

## Important Rules & Conventions

- Prettier and ESLint rules are enforced before commits and in CI.
- `@typescript-eslint/no-non-null-assertion` is an **error** in `src/` (disabled only for `test/**`).
- Never commit credentials, private key material, real mailbox dumps (`*.eml`), or local databases (`*.db`).
- Note: Machine-local agent tooling (`.kilo/`, `graphify-out/`) is deliberately ignored in git.
