# Message Operator POC3 — Architectural Context & Patterns

## Core Architecture

Message Operator is an email environment structured around a **FileSystem contract** (Path Jail and Maildir layout) rather than a specific language API. It separates execution into two key parts:

1. **The Room (Unprivileged, Path-Jailed)**: Where the AI agent works, drafts, reads and searches mail using the in-room `mail` CLI (`mail.py`, stdlib-only Python 3 reading the store read-only — the deployment machines guarantee a system Python but no invokable Node).
2. **The Broker (Privileged)**: Holds credentials and the SQLite store (`broker/store.db`, WAL + FTS5: metadata for the ENTIRE mailbox, resumable sync state, LRU body-cache accounting). It syncs recent mail with bodies, backfills history as metadata in strictly time-boxed chunks (~2.5s per tool-call edge), downloads bodies on demand (`mail fetch` → per-account `.Cache` maildirs, LRU-evicted under a quota), applies delivery/policy rules, and audits files inside the Room at tool-call boundaries.
