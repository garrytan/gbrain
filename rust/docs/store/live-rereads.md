# Live re-reads

The scoped contradiction reader's re-reads by id (`src/core/eval-contradictions/scoped-read.ts`), SQL in
`src/core/engine-sql/contradictions-cycle.ts`, served by `gbrain_store::chunk_queries` (`live_rereads.rs`;
TypeScript members in `src/core/rust-engine/store-members/live-rereads.ts`).

| Member | Answer | SQL |
|---|---|---|
| `brain.listLiveChunksByIds({ ids, scope })` | `{ id, page_id, slug, source_id, chunk_text }[]`: the chunks with these ids whose page passes `scope` (`pageReadFilter(p, policy, live)`: source clause, page privacy policy, page trust floor and flag suppression, not deleted, not quarantined, source live and not archived; the safe-chunk fence under `requireSafeChunks`) and is served, at or below the page's body generation (`chunkVisibleFilter`). The scope's floor is the call's floor when given, else the policy's `minTrust`. Id order | `listLiveChunksByIds` |
| `brain.listLiveTakesByIds({ ids, scope, holders, ownerOnly, floor })` | `{ id, page_id, slug, source_id, row_num, claim, holder }[]`: the active takes with these ids whose page passes `scope` (the policy's own page floor, no safe-chunk fence), whose holder is in `holders` when given, that pass their own owner-only test under `excludePrivate` (`ownerOnlyTakeAllowedSql` in `ownerOnly`'s form; the store keeps no take lineage, so `fn` hides nothing and `closed` hides every take once the brain guards owner-only data) and whose row tier is at or above `floor` (`projectionEligibleSql`). The store keeps no `needs_rederive` rows. Id order | `listLiveTakesByIds` |

Chunk and take ids have no index in the store, so each read scans every page and its chunks (or every take),
as `cosinesByChunkIds` does.
