# The brain store: test-only seed writes

Part of the store contract in [rust/README.md](../../README.md) ("The brain store").

Some parity cases need a page state that PGLite and Postgres reach with a raw `UPDATE pages SET ...` and that no
`BrainEngine` member writes: a shared `updated_at` (several pages written in one instant, so the slug breaks a tie) and a
soft-deleted page carrying a file path. A third state is the belief ledger's page lifetimes, which `enableBeliefLedger` mints
on the SQL engines. The store has no writer for any of them. Three seed methods give a Rust brain the same state. They are not part of the engine and not part of the shipped addon.

| JS | Does |
| --- | --- |
| `brain.seedPageUpdatedAt(sourceId, slug, updatedAtMicros)` | sets the page's `updated_at` |
| `brain.seedPageOrigin(sourceId, slug, sourcePath, deletedAtMicros)` | sets the page's `source_path` and `deleted_at` (`null` is SQL NULL) |
| `brain.seedBeliefPageLifetimes(sourceId, slugs)` | mints one open belief page lifetime for each named page that has none ([collate-belief-reads.md](collate-belief-reads.md)) |

## Where they live

- `crates/gbrain-store/src/test_seeds.rs` is compiled only with the cargo feature `test-seeds`.
- `crates/gbrain-napi/src/families/test_seeds.rs` is compiled only with the napi crate's `test-seeds` feature, which
  turns on the store's.
- Neither feature is a default. `rust/scripts/build.ts` passes `--features test-seeds` only when
  `GBRAIN_RUST_TEST_SEEDS=1`, so `bun run rust:build` builds the shipped addon.
- Only `test/engine-parity/rust-arm.ts` and `harness.ts` call them. A case that needs one throws "build the arm addon with
  GBRAIN_RUST_TEST_SEEDS=1 bun run rust:build" when the addon lacks it.

## Running the cases that use them

```
GBRAIN_RUST_TEST_SEEDS=1 bun run rust:build
GBRAIN_TEST_RUST_ARM=1 GBRAIN_TEST_RUST_ENGINE_ADDON=<the built .node> GBRAIN_RUST_ENGINE_ADDON=<the same> bun test test/engine-parity/<file>.test.ts
cargo test -p gbrain-store --features test-seeds
```

## The shipped build does not export them

`strings <addon>.node | grep -c seedPage` is 0 for the default build and non-zero for the seed build; the proof for the
change that added them is in its notes.

## Without the feature

A case declared `testSeeds: true` that runs on an addon built without the feature stops on the typed
`engine_capability_missing` refusal naming `test_seeds` (a test-only capability name, raised by the seed fixture in
`test/engine-parity/rust-arm.ts`). The Rust arm counts it as stopped, so a default addon keeps every parity file green.
`test/engine-parity/rust-tally.tsv` pins the counts of the default addon; an addon built with the feature does better and
prints the new counts.
