# Research records

Completed experiments and decisions, including negative and inconclusive results.
These are historical evidence, not promises about current GBrain behavior.

| Date | Research | Decision |
|---|---|---|
| 2026-11-16 | [Multi-user prior art for the Rust engine](rust-engine/multi-user-prior-art.md) | Research only; no code changed. Recommends optimistic, serializable transactions in the FoundationDB style over a proven embedded store (redb leads the bake-off), deterministic simulation from the start, and a replacement without PGLite-style whole-brain locking for each Postgres lock and queue pattern gbrain uses today. Avoid the Rust Postgres rewrite as a dependency. |
| 2026-09-29 | [PGLite managed-persistence write throughput](pglite-persistence-throughput-2026-09-29.md) | Shipped. PGLite soak 8.9 → 31.7 writes/s in matched 1,000-write runs on `standard-30`; the 10,000-write gate soak drops from 1,417 s to 277–308 s; Postgres 11.2 → 13.5 writes/s; all crash boundaries and full gates pass. |
| 2026-09-24 | [T-Mem validation for GBrain](t-mem-2026-09-24/postmortem.md) | Feature [#5374](https://github.com/garrytan/gbrain/pull/5374) is mothballed, not merged. Preserve the research and evaluator separately: no completed custom feature-on score; a released-code pilot found a small descriptive-trigger retrieval signal but no demonstrated answer-quality gain. |

## Living research maps

| Research | What it is |
|---|---|
| [Rust rewrite research maps](rust-engine/README.md) | Maps of what TypeScript gbrain and gbrain-evals do today (storage engine, agent contract, jobs, tests, evals), pinned to one commit. The plan of record is [docs/designs/RUST_ENGINE.md](../designs/RUST_ENGINE.md) (PR #9593); the draft [PLAN.md](../plans/PLAN.md) is kept as research. |
