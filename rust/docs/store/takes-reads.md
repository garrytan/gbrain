# The brain store: takes, salience and code-edge reads

Part of the takes family ([takes.md](takes.md)); the rules in [rust/README.md](../../README.md) ("The brain store") apply.

Nine single-purpose reads that used to be raw SQL in doctor, onboarding, the fact purge, the fence import, the MCP
scorecard, the take repair, the take rows generation adapter and the takes writes. Each is now one engine member, with
the SQL in `src/core/engine-sql/takes-reads.ts` (PGLite and Postgres) and a native read in the store. A take is scoped
by the page it hangs on, read now.
Fourteen single-purpose reads that used to be raw SQL in doctor, onboarding, the fact purge, the fence import, the MCP
scorecard, the take repair, the takes writes, the take rows generation adapter, the take write gate, the accepted-takes
and lost-fence-rows repairs, the trust explainers and the calibration admin routes. Each is now one engine member, with the SQL in
`src/core/engine-sql/takes-reads.ts` (PGLite and Postgres) and a native read in the store, except
`listHeldFenceTakeRows`, which needs state the store does not keep. A take is scoped by the page it hangs on, read now.

| Member | Returns | Used by |
| --- | --- | --- |
| `brain.countOffGridTakeWeights()` | `{ off_grid, total }` over every take: weights further than 0.001 from the 0.05 grid | doctor `takes_weight_grid` |
| `brain.countTakes()` | the number of takes | onboarding `checkTakesCount` |
| `brain.planFactPurgeTakes({ sourceId, factIds, factHash, subject })` | `[{ id, page_id }]` by id: takes of the source that the purged facts were consolidated into, or whose claim has the purged fingerprint on the subject's page (`*` is every page) | `planFactPurge` |
| `brain.listTakeRowsForPage(pageId)` | `[{ row_num, claim }]` by row number (the SQL gained an `ORDER BY row_num`; it was unordered) | fence import `storedFenceRows` |
| `brain.readTakePreimages({ pageId, by, gone, incoming })` | `[{ preimage, gone }]` by row number: the full row (`TAKE_PREIMAGE_SQL`, `resolved_at` as jsonb writes it, `…+00:00`) of each take of the page that `gone` names (by id or by row number), and of each take an incoming row of its number would replace (another claim, kind or holder; a missing field differs). A take is listed once per incoming row of its number, as the `LEFT JOIN` does. The member checks every number first | `generations/adapters/take-rows.ts` |
| `brain.listHeldFenceTakeRows({ sourceId, kind, ownerKey, pageId })` | the page's takes by row number (row number, claim, kind, holder, weight, dates, source, active and the resolution cells) while the store's `derived_generations` row of the key is held `fence_absent` (`generations::held_for`); `[]` otherwise, and for a page id below zero. The member turns `resolved_at` into a Date |
| `brain.readTakeRowTrust(pageId, rowNum)` | `{ id, claim, trust_tier }` of the take at that row number, or null; the tier as stored (`unknown` when unset) | take write gate (`takes_remove`, `takes_supersede`, the contested new row), accepted-takes and lost-fence-rows repairs |
| `brain.readTakeTrustRef(id)` | `{ id, source_id, claim, trust_tier, write_origin, active, quarantined }` or null: the page's source, `write_origin` in jsonb key order, and whether the page's frontmatter holds the `quarantine` key | `gbrain trust explain` (trust review and eligibility explain) |
| `brain.countMcpResolvedTakes({ sourceIds, holders, excludePrivate })` | resolved takes whose `resolved_by` starts with `mcp:`, on a page in the source scope, held by a listed holder | `countMcpResolved` |
| `brain.listTakeSupersessionCandidates(sourceIds)` | `[{ id, source_id, slug }]` by page id: live pages with an inactive take or a source cell saying `superseded by #` (any case) | take supersession repair |
| `brain.listTopResolvedTakesForHolder(holder)` | `[{ id, page_slug, row_num, claim, weight, resolved_quality, since_date }]`: the holder's 25 active resolved takes of highest weight, a newer `since_date` first within a weight (a null one first); `id` is text | `/admin/api/calibration/pattern/:id` |
| `brain.listAbandonedTakes()` | `[{ id, page_slug, claim, weight, since_date }]`: the 5 active, unresolved, unsuperseded takes of weight 0.7 or more whose `since_date` (`YYYY-MM` reads as the 1st) is more than 12 months ago, oldest first | `/admin/api/calibration/charts/abandoned-threads` |
| `brain.countZeroWeightWithTakes()` | `{ zero_weight_with_takes, nonzero_weight }`: pages with an active take and weight 0 (never weighed reads 0), and pages with weight above 0; soft-deleted pages count | doctor `salience_health` |
| `brain.hasCodeEdgesSymbol(sourceId)` | whether the source owns an unresolved (symbol-table) edge | `symbol-resolver` |

Differences from PGLite and PostgreSQL:

- `countMcpResolvedTakes` with `excludePrivate` skips the takes of pages the page policy hides, the way the SQL
  fragment does, in every source and holder scope. The TypeScript member reads the policy the way the salience reads
  do (`storePagePolicy` in `store-members/private-provenance.ts`: `honorAliases`, `entityPrivacy`) and the store runs
  `page_hidden` per page. The policy carries the caller's reader identity and private-readable grant
  (`callerReaders`), so a member reads the takes on pages whose readers name it and on private pages of a source it
  holds a grant for, as the SQL's `privatePagesFilterForCaller` does. The take's
  page is read whether or not it is soft-deleted, as the SQL joins `pages` without a deleted filter.
- `listTopResolvedTakesForHolder` and `listAbandonedTakes` read every page, soft-deleted or not, as the SQL joins
  `pages` without a deleted filter. They compare `since_date` in byte order; Postgres uses the database collation,
  which agrees for the `YYYY-MM` and `YYYY-MM-DD` dates the takes writers store. Where Postgres leaves a tie (equal
  weight and date, or equal date) in no set order, the store keeps id order.
- `listAbandonedTakes` compares `weight >= 0.7` on the `real` widened to double, as Postgres does, so a stored 0.7
  (0.699999988) is below the floor. It reads `now() - INTERVAL '12 months'` on a UTC session clock (29 February goes
  to 28 February) and each date at midnight UTC. Its `::date` cast reads `YYYY-MM-DD` (or `/` separated, with an
  optional time after it) only; Postgres also reads other date spellings. A row the other filters keep whose
  `since_date` the cast cannot read fails the read with `invalid_argument`, as Postgres fails it; a null
  `since_date` is skipped.
- The weight grid check is exact integer arithmetic on the six-significant-digit decimal that `weight::numeric` of a
  `real` prints, so it agrees with Postgres at the 0.001 boundary and at half-way rounding. A weight with more than 30
  places is within 1e-30 of zero, which is on the grid.
- The typed write API snaps every weight to the grid, so an off-grid weight can only come from a raw insert; the boundary
  is pinned by `rust/crates/gbrain-store/tests/takes_reads.rs` and `test/engine-sql-takes-reads.test.ts`, not by the
  parity test.

## The reads and the delete of `gbrain extract takes`

`cycle/extract-takes.ts` and `generations/adapters/take-rows.ts` read and prune through these members, not raw SQL
(the batch guard is `listGuardedTakeRows` in [trust.md](trust.md); the coverage read `listCoveredSources` returns the sources with a
matching coverage event in their current incarnation). The whole re-extract still stops on the typed `raw_sql` refusal inside
`publishFenceGeneration`, whose ledger statements have no member yet; `test/engine-parity/extract-takes.test.ts` pins it.

| Member | Returns | Used by |
| --- | --- | --- |
| `brain.readLivePageIdBySlug(slug, sourceId)` | the id of the live page, or null; only this read hides a soft-deleted page | `getPageIdForSlug` |
| `brain.readPageTierRef(pageId)` | `{ source_id, slug, trust_tier }` of the page, deleted or not; a stored tier that names no tier reads `unknown` | `reconcileTier` |
| `brain.readPageTierRows(ids)` | `[{ id, source_id, slug, trust_tier }]` by id, once per id, deleted or not | `upsertProjectedTakes` |
| `brain.pageHasFrontmatterKey(pageId, key)` | whether the page's frontmatter has the top-level key (`frontmatter ? key`), deleted or not | the checkout's quarantine check |
| `brain.listTakeIdsLeavingFence(pageId, fence)` | the ids of the page's takes at no listed row number (`removed`), or that no row restates with the same claim (`replaced`) | `unheldTakes` |
| `brain.listTakePreimages(pageId, ids, incoming)` | `[{ preimage, gone }]` by row number: the gone takes and those an incoming row of the number restates with another claim, kind or holder, once per such row (the SQL's `LEFT JOIN`) | `takePreimages` |
| `brain.deleteTakesByIds(ids)` | deletes the listed takes on any page with the evidence rows that cite them; an empty list writes nothing | the prune delete |
| `brain.findTakeId(pageId, rowNum)` | the id of the page's take at the row number, or null | `upsertProjectedTakes` |

The `preimage` object has the keys of `TAKE_PREIMAGE_SQL`; `resolved_at` is printed the way `jsonb_build_object` prints
a `timestamptz`. The TypeScript members refuse an id that is not an integer. Pinned by
`rust/crates/gbrain-store/tests/takes_extract.rs`, `test/engine-parity/extract-takes-reads.test.ts` and, for the
Postgres text, `test/extract-takes-sql-pin.test.ts`.

## The take-supersession repair

| Member | Answer | Caller |
|---|---|---|
| `brain.listTakePointers(pageId)` | each take's row number and stored `superseded_by` | the reprojection check |
| `brain.listTakeSupersedeReceipts(sourceId, pageId, slug)` | the old and new row of each `takes_supersede` receipt of the page | the preview |
| `brain.setTakeSupersededBy(pageId, rowNum, target)` | sets or clears one take's pointer and nothing else | the reprojection |

The fence rewrite goes through the page write, which the Rust engine refuses by name. Pinned by
`rust/crates/gbrain-store/tests/takes_supersession_repair.rs` and `test/engine-parity/repair-takes-timeline.test.ts`.
