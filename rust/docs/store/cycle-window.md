# The brain store: a per-source cycle's window

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the reads a per-source cycle's changed-page window (`src/core/cycle/source-window.ts`, `listSourceChangedPages`)
ran through `executeRaw`. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/cycle-window.ts`; the
texts are pinned by `test/engine-sql-caller-raw-sql-pins.test.ts`). The TypeScript side is
`src/core/rust-engine/store-members/sources.ts` and the Rust side is `crates/gbrain-store/src/cycle_window.rs` (behavior
pinned by `tests/cycle_window.rs`). The window reads the stamped cursor with `readSourceState` and the cycle stamps it
with `updateSourceConfig`, members the store already serves.

| JS | Reads | Rule |
| --- | --- | --- |
| `brain.readCycleListingInstant()` | the store clock now, as UTC ISO text with microseconds. The SQL engines move it back to just before the oldest transaction open on another connection (at most ten minutes); the store has one writer and no other connection, so nothing holds it back | one value |
| `brain.listSourceChangedPagesAfter(sourceId, since \| null, slug, limit)` | the source's live pages whose `(updated_at, slug bytes)` is after `(since, slug)`, or every live page when `since` is null: `{ slug, updated_at }`, `updated_at` UTC ISO with microseconds. `since` must be that ISO shape; another refuses `invalid_argument` | `(updated_at, slug bytes)` order, at most `limit` |
