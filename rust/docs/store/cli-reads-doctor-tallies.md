# The brain store: doctor tallies

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are counts `gbrain doctor` checks ran through `executeRaw` inside a catch that turned the Rust engine's capability
refusal into a quiet zero (the lane 14 swap blockers of the refusal-swallow triage). PGLite and Postgres run the same SQL
as before (`src/core/engine-sql/doctor-tallies.ts`). The store answers from the page, fact and timeline records each
statement read (`crates/gbrain-store/src/cli_reads/doctor_tallies.rs`) and has no keys of its own. The TypeScript side is
`src/core/rust-engine/store-members/doctor-tallies.ts`. The cross-engine cases are in
`test/engine-parity/refusal-swallow-sites.test.ts`.

| JS | Resolves | Doctor check |
| --- | --- | --- |
| `countLiveSegmentedPages({ projectionPending })` | live pages that keep their body in segments; with `projectionPending`, only those whose text projection revision is not their knowledge revision (none counts) | `oversized_pages`, `text_projection_readiness` |
| `countValidityLapsedFacts()` | facts whose `valid_until` is at or before now and that have no `expired_at` | `memory_writeback` |
| `countOrphanEventProjections(sourceIds \| null)` | timeline rows whose event page exists and is soft-deleted, when that page is in `sourceIds` (null: every source) | `chronicle_projection_health` |
