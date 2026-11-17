# Rust engine research maps

These twelve maps are research for a Rust third engine behind `BrainEngine`, next to PGLite and Postgres. The design they feed is in [`../../RUST_ENGINE.md`](../../RUST_ENGINE.md). Each map reads the TypeScript implementation and its tests and records what a Rust engine must match, what it can simplify, and which questions are still open.

**Precedence.** The maps were written before the design was settled, and some of their implication sections explore a wider rewrite: one engine instead of a parity matrix (`01`), a Rust CLI and middleware (`05`), dropping the engine test matrix and TypeScript guards (`10`), a stdio `oracle-ts` route for gbrain-evals (`11`) and dropping the embedded PGLite lane (`12`). Those passages are kept as research history and do not bind. The approved [`../../RUST_ENGINE.md`](../../RUST_ENGINE.md) governs: it keeps the TypeScript surfaces, keeps PGLite and Postgres as engines, and defers the stdio route. Where a map and the plan disagree, the plan wins.

## Pinned commits

- gbrain: `36bd05806a` (v0.60.733.0). Line numbers in every map refer to this commit.
- gbrain-evals: `9ecc5b20` (2026-05-24). That commit is about 3,500 commits behind gbrain-evals main as of 2026-11-16, so `11` is history for that repository: its counts, broken-runner notes and pin status are out of date, and the plan's D11 records the current terms.

## Evidence tags

Each map tags its claims as verified (code read), reported (doc quote) or inferred. The tag letters differ slightly per map (for example `[V]`, `[I]`, `[R]`, `[D]`, `[C]`, or "(inferred)"), and each map states its own legend near the top.

## Maps

| Map | Summary |
|---|---|
| [01-engine-interface.md](01-engine-interface.md) | The `BrainEngine` seam, `engine-sql`, and how much raw SQL bypasses the interface. |
| [02-schema.md](02-schema.md) | `src/schema.sql` table by table: indexes, triggers, RLS, migration-created tables, and graduation inventory. |
| [03-search-pipeline.md](03-search-pipeline.md) | Retrieval and ranking end to end: arms, fusion, boosts, filters, and the Postgres features each piece needs. |
| [04-ingest-chunk-embed.md](04-ingest-chunk-embed.md) | The write path: parse, chunk, embed, store, plus the triggers that fire on write. |
| [05-cli-mcp-surface.md](05-cli-mcp-surface.md) | The agent-facing surface: operations, CLI verbs, MCP surfaces, scopes, and exit codes. |
| [06-graph-and-knowledge.md](06-graph-and-knowledge.md) | The knowledge layer: links and graph traversal, entities, facts, takes, timeline. |
| [07-jobs-and-cycles.md](07-jobs-and-cycles.md) | The Minions job queue, autopilot, and the cycle phases. |
| [08-concurrency-and-persistence.md](08-concurrency-and-persistence.md) | Locking, persistence ownership, and the multi-process model. |
| [09-access-and-security.md](09-access-and-security.md) | Trust boundary, credentials, per-member access, and the invariants the database enforces today that must move into Rust code. |
| [10-tests.md](10-tests.md) | The TypeScript test suites as a parity oracle, and a `GBRAIN_BIN` harness proposal. |
| [11-gbrain-evals.md](11-gbrain-evals.md) | gbrain-evals as a parity oracle: runners, gates, and what a Rust engine must satisfy. |
| [12-perf-and-operations.md](12-perf-and-operations.md) | Performance, scale, and operations: sizing, budgets, install and upgrade paths, and what users need to switch. |
