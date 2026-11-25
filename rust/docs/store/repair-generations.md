# The generation repair reads (batch 7)

The typed members the generation repair kinds read through, so their previews run on a Rust brain. Each has one SQL
copy in `src/core/engine-sql/` and a store function here; the parity cases are in
`test/engine-parity/repair-generation-kinds.test.ts`. `gbrain repair generations` reads through lane 7's generation
members (`generations.md`).

| Members | Repair kind | SQL | Store | Contract |
|---|---|---|---|---|
| `listRetiredFenceItems` | `lost-fence-rows` | `lost-fence-reads.ts` | `src/generations/lost_fence.rs` | Retired items with a preimage of the unproven, unheld page fence generations of the sources (or of one page), with the generation's creation time as text, by source, owner key, generation and item key. |
| `listInlineVersionTexts` | `lost-fence-rows` | `lost-fence-reads.ts` | `src/repair_versions.rs` | A page's versions with an inline body, by id. |
| `hasActiveFactText`, `readFactTrustTier`, `listFenceFactRowNums`, `readLiveFactRowTier` | `lost-fence-rows` | `lost-fence-reads.ts` | `src/facts/text_repair.rs` | Whether an active fact of a page holds a text at a visibility; a fact's stored trust tier; the fence row numbers of a page's facts; the id and tier of the live fact in one row that holds a text. |
| `hasTakeClaim`, `listTakeRowNums`, `readTakeRowTierByClaim` | `lost-fence-rows` | `lost-fence-reads.ts` | `src/takes/reads.rs` | Whether a take of a page holds a claim; a page's take row numbers; the id and tier of the take in one row that holds a claim. |
| `listStaleAtoms` | `stale-atoms` | `stale-atom-reads.ts` | `src/page_ops/stale_atoms.rs` | Live atoms whose origin page is gone, or moved past them with a completed extraction of its new content (an unmanaged atom that holds the new hash, or a managed-atoms checkpoint), gone origins first, then by id. With an atom id only that atom. |

The `lost-fence-rows` restore is a page write, which runs on the Rust engine (the fence projection's statements,
[facts.md](facts.md#the-fence-projections-statements)). The `stale-atoms` retirement bumps the origin's atom ledger through
`readAtomGeneration` and `recordAtomGenerationBump` (`atom-generation.ts`; the store's op checkpoint rows,
`src/persistence/op_checkpoint.rs`), so it applies on every engine.
