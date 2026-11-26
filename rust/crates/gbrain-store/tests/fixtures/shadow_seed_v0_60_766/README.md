# A shadow store written by the v0.60.766.0 Rust addon

`store.json` is every record of a store that the v0.60.766.0 store crate wrote: `generate.rs`, built
against origin/master `rust/crates/gbrain-store` at 9ae266f1e8 (byte-identical to the release commit
ae4bef02ce), seeds `rows.json` through `Store::import_relation_with_digests` (the call
`gbrain engine shadow seed` makes) and dumps the redb `kv` table as hex pairs. Its format record says 5.

`src/seed/v0_60_766_tests.rs` loads these records into an empty record file, opens it with this build
and compares every read and record with a store this build seeds from the same rows.

To regenerate: make a scratch crate with `generate.rs` as `src/main.rs`, depending on that
`gbrain-store` path, `redb = "=4.6.0"` and `serde_json`, then run
`cargo run --release -- rows.json <empty dir> > store.json`.
