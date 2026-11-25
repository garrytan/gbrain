# Snapshot notes: rust-engine/serialized-transactions (lane L0, groundwork G1 + G12)

Notes for the snapshot PR body that carries this branch. Not user documentation.

- **Shadow evidence capability hash (deferred review finding, p1/outside-voice#10).** The shadow child hashes the
  static `servedCapabilities()` set (`src/shadow/child.ts`), which never holds `serialized_transactions` or the write
  journal a non-serializing store withholds. Today that hash is byte-identical to trunk's. What breaks when the
  capability turns off (lane L1, `GBRAIN_RUST_MULTIUSER=1`): a store whose transactions no longer serialize gets the
  same capability hash, so the shadow evidence epoch does not roll over and evidence gathered in serialized mode would
  be counted for the multi-writer mode. Fix with L1: hash the engine's live capability set (open-store guarantees
  included) and bump `SHADOW_ADAPTER_VERSION` then. This branch keeps version 8 and re-pins the adapter digest at 8, as trunk merges do.
- **Open test gap, closed.** A deep keyword query's worker thread reusing the caller's vector cache is now pinned
  (`keyword::vector_cache::tests::a_deep_query_worker_reuses_and_fills_the_callers_cache`).
