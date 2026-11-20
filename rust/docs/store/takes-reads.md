# The brain store: takes, salience and code-edge reads

Part of the takes family ([takes.md](takes.md)); the rules in [rust/README.md](../../README.md) ("The brain store") apply.

Nine single-purpose reads that used to be raw SQL in doctor, onboarding, the fact purge, the fence import, the MCP
scorecard, the take repair and the takes writes. Each is now one engine member, with the SQL in
`src/core/engine-sql/takes-reads.ts` (PGLite and Postgres) and a native read in the store, except
`listHeldFenceTakeRows`, which needs state the store does not keep. A take is scoped by the page it hangs on, read now.

| Member | Returns | Used by |
| --- | --- | --- |
| `brain.countOffGridTakeWeights()` | `{ off_grid, total }` over every take: weights further than 0.001 from the 0.05 grid | doctor `takes_weight_grid` |
| `brain.countTakes()` | the number of takes | onboarding `checkTakesCount` |
| `brain.planFactPurgeTakes({ sourceId, factIds, factHash, subject })` | `[{ id, page_id }]` by id: takes of the source that the purged facts were consolidated into, or whose claim has the purged fingerprint on the subject's page (`*` is every page) | `planFactPurge` |
| `brain.listTakeRowsForPage(pageId)` | `[{ row_num, claim }]` by row number (the SQL gained an `ORDER BY row_num`; it was unordered) | fence import `storedFenceRows` |
| `brain.listHeldFenceTakeRows({ sourceId, kind, ownerKey, pageId })` | `[]`: the store keeps no fence generations (`derived_generations`), so no take_fence generation is ever held `fence_absent`. PGLite gives the page's takes by row number, resolution cells included, only while that generation is held. | `takes_add`, `takes_update` and the lost-fence repair (`heldTakeRows`) |
| `brain.countMcpResolvedTakes({ sourceIds, holders, excludePrivate })` | resolved takes whose `resolved_by` starts with `mcp:`, on a page in the source scope, held by a listed holder | `countMcpResolved` |
| `brain.listTakeSupersessionCandidates(sourceIds)` | `[{ id, source_id, slug }]` by page id: live pages with an inactive take or a source cell saying `superseded by #` (any case) | take supersession repair |
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
- The weight grid check is exact integer arithmetic on the six-significant-digit decimal that `weight::numeric` of a
  `real` prints, so it agrees with Postgres at the 0.001 boundary and at half-way rounding. A weight with more than 30
  places is within 1e-30 of zero, which is on the grid.
- The typed write API snaps every weight to the grid, so an off-grid weight can only come from a raw insert; the boundary
  is pinned by `rust/crates/gbrain-store/tests/takes_reads.rs` and `test/engine-sql-takes-reads.test.ts`, not by the
  parity test.

## The reads and the delete of `gbrain extract takes`

`cycle/extract-takes.ts` and `generations/adapters/take-rows.ts` read and prune through these members, not raw SQL
(the batch guard is `listGuardedTakeRows` in [trust.md](trust.md); the coverage read `listCoveredSources` answers `[]`
on the store, which records no belief events). The whole re-extract still stops on the typed `raw_sql` refusal inside
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

## The grade_takes verdict cache

`gbrain takes grades` and the grade_takes cycle phase read and write `take_grade_cache` through four members. The store
keeps each row at `A 0x05 <take id> <prompt_version> 0x00 <judge_model_id> 0x00 <evidence_signature>` (a JSON record:
the key, `wave_version`, `graded_at`, the verdict, `confidence` as a `real` and `applied`), in `takes/grades.rs`.

| Member | Returns | Used by |
| --- | --- | --- |
| `brain.readTakeGrade(key)` | `{ verdict, confidence, applied }` of the row at the key, or null | the phase's cache check |
| `brain.insertTakeGrade({ ...key, verdict, confidence, applied, gradedAt? })` | stores the verdict unless a row holds the key (`ON CONFLICT DO NOTHING`); a verdict outside the four qualities fails `take_grade_cache_verdict_check`; `gradedAt` (ISO 8601) defaults to now | the phase's verdict write |
| `brain.deleteTakeGrade(key)` | deletes the row at the key; a key with no row deletes nothing | the managed phase's rollback |
| `brain.listLatestTakeGrades({ verdict, minConfidence, applied, limit })` | the newest row of each take on a live page, then the filters (`minConfidence` compares as a `real`), newest first (`graded_at`, then take id), at most `limit` rows, with the page's `source_id` and slug and the take's row, claim, holder and `since_date` | `gbrain takes grades` |

Two rows of one take with the same `graded_at` are a tie that Postgres breaks arbitrarily; the store keeps the first
in key order. `insertTakeGrade` also takes an optional `waveVersion` (default `v0.36.1.0`). Pinned by the unit test in
`takes/grades.rs` and `test/engine-parity/caller-typed-reads.test.ts`.

`readLiveTakePage({ pageId, rowNum, claim })` is grade_takes' managed resolve: `{ slug, source_id }` of the page when it
is not soft-deleted and its take at that row still holds the claim, else null (`takes/reads.rs`).

## Take horizons

`gbrain takes horizon` and the forecast journal read and write `take_horizons` through five members. The store keeps
each row at `A 0x06 <take id>` (a JSON record: `claim_sha256`, `horizon_date` as `YYYY-MM-DD`, `basis`, `set_at`), in
`takes/horizons.rs`. Deleting a take deletes its horizon (`take_horizons_take_id_fkey ... ON DELETE CASCADE`).

| Call | Result | Caller |
| --- | --- | --- |
| `brain.readTakeClaim(takeId)` | the take's claim, or null | horizon set |
| `brain.upsertTakeHorizon({ takeId, claimSha256, horizonDate, basis })` | sets or replaces the horizon, stamped now; a date that is not `YYYY-MM-DD` fails the date cast, a basis outside `stated`, `stated_relative`, `owner` fails `take_horizons_basis_check`, a missing take fails `take_horizons_take_id_fkey` | horizon set and scan --apply |
| `brain.deleteTakeHorizon(takeId)` | true when the take had a horizon | horizon clear |
| `brain.listTakeHorizons(takeIds \| null)` | the horizons whose take exists, by take id, with the take's claim now | forecast journal |
| `brain.listHorizonScanRows(sourceId \| null)` | every take on a live page of the source, by take id, with its horizon fields or nulls | horizon scan |

## A calibration wave's writes

`gbrain calibration --undo-wave` runs on four members besides `purgeCalibrationProfilesByWave`
(calibration-profiles.md). Each returns a count; a dry run only counts.

| Call | Result |
| --- | --- |
| `brain.listWaveAppliedTakeIds(waveVersion)` | the distinct take ids of the wave's applied `A 0x05` rows, ascending |
| `brain.revertWaveTakeResolutions({ takeIds, resolvedBy, dryRun })` | the takes `resolvedBy` resolved; clears their seven resolution fields, `updated_at` unchanged (runs in the maintenance transaction) |
| `brain.unapplyWaveTakeGrades({ waveVersion, dryRun })` | the wave's applied rows; marks them unapplied (the rows stay) |
| `brain.purgeTakeNudgesByWave({ waveVersion, dryRun })` | the wave's `take_nudge_log` rows; deletes them |

The nudge log lives at `A 0x07 <nudge id>` (counter `M next_take_nudge_id`), in `takes/nudges.rs`.
`brain.insertTakeNudge({ sourceId, takeId?, proposalId?, nudgePattern, channel?, waveVersion?, firedAt? })` logs a row
and returns its id; it checks `take_nudge_log_target_xor`, then `take_nudge_log_source_id_fkey`. The store keeps no
`take_proposals`, so a nudge at a proposal always fails `take_nudge_log_proposal_id_fkey`. A source delete deletes the
source's nudges. No src writer inserts nudges yet; tests and fixtures use `insertTakeNudge`.
