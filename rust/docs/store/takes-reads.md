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
| `brain.listTakeHoldersAtRows(pageId, rowNums)` | the distinct holders of the page's takes at those row numbers, sorted (the SQL's `DISTINCT` sets no order) | `authorizeStoredTakeHolders` (persistence/authority.ts) |
| `brain.stampTakeResolvedAt(pageId, rowNum, resolvedAt)` | sets only `resolved_at` of the take at the row number (a date reads as midnight UTC); no take there writes nothing; text that is not a time is refused | the takes prepare step (persistence/takes-prepare.ts) |
| `brain.recordTakeHoldersUsed(requestId, holders)` | sets the stored request's `authority.takeHoldersUsed` to `holders`; a request that is not stored, or an authority that is not an object, is left alone | the takes prepare step |

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
and returns its id; it checks `take_nudge_log_target_xor`, then `take_nudge_log_source_id_fkey`, then that the proposal it names
is stored (`take_nudge_log_proposal_id_fkey`). Deleting a proposal deletes its nudges (`ON DELETE CASCADE`). A source
delete deletes the source's nudges. No src writer inserts nudges yet; tests and fixtures use `insertTakeNudge`.

## Take proposals

The propose_takes cycle step fills `take_proposals`, and `gbrain takes propose` lists, accepts and rejects its rows
(`src/core/engine-sql/take-proposals.ts` holds the SQL). The store keeps each row at `A 0x08 <id>` (a JSON record of
every column, `weight` as a `real`; counter `M next_take_proposal_id`) and the idempotency index at
`A 0x09 <source>\0<slug>\0<content_hash>\0<prompt_version>\0<sha256(claim_text)>` → id, in `takes/proposals.rs`. The
index stands in for `ON CONFLICT (source_id, page_slug, content_hash, prompt_version, md5(claim_text))`; its prefix
before the claim hash is the propose_takes cache key.

| Call | Result |
| --- | --- |
| `brain.listPendingTakeProposals({ sourceId?, limit })` | the pending rows (twelve columns), newest first (`proposed_at`, then id); `limit` truncated and clamped to 1..500 |
| `brain.readTakeProposal(id, sourceId?)` | the row whatever its status, or null; with a source, another source's row reads as null |
| `brain.claimTakeProposal(id, actedBy)` | a pending row becomes `accepted`, acted now; `{ id, acted_at }`, or null when it is not pending |
| `brain.readStrandedTakeProposalClaim(id)` | `{ id, acted_at }` of an accepted row with no promoted take, or null |
| `brain.releaseTakeProposalClaim(id, claimedAt)` | puts such a row back to pending while its `acted_at` (to the millisecond) is `claimedAt` |
| `brain.setTakeProposalPromotedRow(id, rowNum)` | records the take row; a row number outside `integer` refuses |
| `brain.rejectTakeProposal(id, actedBy)` | true when the row was pending and is now `rejected` |
| `brain.takeProposalCached(key)` | whether any row (tombstones too) is under the page key |
| `brain.listRejectedTakeProposalClaims(sourceId, pageSlug)` | the claims rejected by an operator (acted on), by id |
| `brain.insertTakeProposal(input)` | the new id, or null when the claim is under its page key; a status outside the four fails `take_proposals_status_check`, an unknown source `take_proposals_source_id_fkey` (the id is taken first, as a sequence is) |
| `brain.listTakeProposalTombstones(sourceId, prefix)` | the failure tombstones (rejected, never acted on, claim starting with `prefix`) by slug then id; `proposed_at` is Postgres text |
| `brain.deleteTakeProposalTombstones(sourceId, prefix, slug?)` | deletes them with their nudges; the slugs released, sorted, each once |
| `brain.listProposeTakesCandidatePages({ sourceIds?, sourceId?, types, limit })` | `{ slug, source_id, compiled_truth }` of the live pages the step reads (no receipts, atoms, dream, atom-extractor or concept pages, no guest sources), newest first; an empty `types` list matches no page |

The failure ledger keeps one JSON document in an op checkpoint row: `brain.readOpCheckpointDoc(op, fingerprint)` and
`brain.writeOpCheckpointDoc(op, fingerprint, doc)` (`persistence/op_checkpoint.rs`). An accept reads the write
requests it admitted with `brain.listWriteRequestsByRequestId(requestId)` (`persistence.rs`). A source delete deletes
the source's proposals and their index entries. Pinned by the unit tests in `takes/proposals.rs` and
`test/engine-parity/take-proposals.test.ts`.
The extract receipt and rollup rows the cycle writes alongside are in [extract-bookkeeping.md](extract-bookkeeping.md)
(`A 0x0A`); the take-path gaps still refused on this engine are listed in [journal.md](journal.md).
## The take-supersession repair

| Member | Answer | Caller |
|---|---|---|
| `brain.listTakePointers(pageId)` | each take's row number and stored `superseded_by` | the reprojection check |
| `brain.listTakeSupersedeReceipts(sourceId, pageId, slug)` | the old and new row of each `takes_supersede` receipt of the page | the preview |
| `brain.setTakeSupersededBy(pageId, rowNum, target)` | sets or clears one take's pointer and nothing else | the reprojection |

The fence rewrite goes through the page write, which the Rust engine refuses by name. Pinned by
`rust/crates/gbrain-store/tests/takes_supersession_repair.rs` and `test/engine-parity/repair-takes-timeline.test.ts`.
