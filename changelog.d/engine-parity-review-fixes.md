**Four engine parity cases are now deterministic or stricter: two no longer depend on timing or tie order, and a new case checks that a failed chunk replacement rolls back.**

### Tests
- The `listFactsKeyset` paging case no longer fails when two back-to-back facts get the same timestamp, which happened in about one run in five on PGLite. It now spaces its inserts until the clock moves and makes two rows share a timestamp on purpose, so it also checks that the cursor's id breaks the tie.
- The take vector-search case no longer has two takes with the same score. Search orders by distance only, so tied takes could come back in either order.
- A new `sealChunks` case checks that a chunk write that fails after the old chunks were deleted leaves the old sealed chunks in place and searchable.
- The `withReservedConnection` case declares that it needs raw SQL, so the planned Rust engine is expected to refuse it.
