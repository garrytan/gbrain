# The brain store: doctor reads, facts, fence and trust

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that the `gbrain doctor` facts, fence and trust checks ran through `executeRaw`. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/doctor-facts-trust.ts`; the text is pinned by `test/doctor-facts-trust-sql.test.ts`). The TypeScript side is `src/core/rust-engine/store-members/doctor-facts-trust.ts`; the store methods are in `crates/gbrain-store/src/cli_reads/doctor_facts_trust.rs` and `crates/gbrain-store/src/jobs/checks.rs`.

## facts_extraction_health

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.countConversationPipelinePages({types, slug_patterns})` | the live pages whose type is in `types` and whose slug matches none of the `slug_patterns` (LIKE patterns, `%` and `_`) | the `conversationPipelineNote` count |
| `brain.listPersistentWriterContention(reason)` | per source, the facts-absorb deferrals of the last 24 hours with that reason that no later completed `facts-absorb` job covers, kept when there are more than 10 or the oldest is over an hour old | the `persistentWriterContention` query |

A deferral row is covered when a completed `facts-absorb` job for the same page and source finished at or after the row was written. A row with no source belongs to `default`.
