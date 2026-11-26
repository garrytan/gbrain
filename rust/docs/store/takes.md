# The brain store: Takes

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Takes (`takes`, one row per `(page_id, row_num)`) and synthesis evidence (`synthesis_evidence`, a take cited
by a synthesis page). The TypeScript members (`src/core/rust-engine/store-members/takes.ts`) do what the
shared SQL module does before its statement runs: weight normalization (`buildTakeRows`,
`normalizeWeightForStorage`), defaults, limit clamps, `deriveResolutionTuple`, `finalizeScorecard` and every
`GBrainError` (`TAKE_ROW_NOT_FOUND`, `TAKE_RESOLVED_IMMUTABLE`, `TAKE_ALREADY_RESOLVED`). The store answers
with plain statuses and the two store error codes.

Keys (tag `A`, `keys::TAKE`):

- `A 0x01 <id u64 BE>` holds a take record. Ids come from `M next_take_id`; a refused insert takes no id.
- `A 0x02 <page u64 BE><row>` holds the take id: the `(page_id, row_num)` unique index.
- `A 0x03 <synthesis page><take page><row>` holds an evidence record (`citation_index`, `created_at`, the
  synthesis page's source).
- `A 0x04 <take page><row><synthesis page>` is empty: the reverse index a take delete walks.

A take purge tombstone (`F 0x10`, [facts.md](facts.md#the-take-purge-ledger)) refuses a take whose claim it names:
`addTakesBatch` checks every row and `supersedeTake` the new row with `purged_content`, as the `takes_refuse_purged`
trigger does.

`<row>` is `(row_num as u32 ^ 0x8000_0000)` big-endian, so negative row numbers sort first. A take keeps
the `source_id` of its page and a `claim_rev` that moves each time the claim text changes (for the
embedding staleness check owned by core). `addTakesBatch` that changes a take's claim drops the take's stored vector (`embeddings::remove_take_vector`, which also raises the vector generation), as Postgres nulls the embedding in that upsert; deleting a take deletes its vector too.

A take record also holds the `trust_tier` and `write_origin` PGLite's `trust_tier_stamp` trigger stamps
(`trust::stamp_row`, [trust.md](trust.md)), left out of the record while the tier is `unknown` with no origin, so a
record stored before them decodes unchanged. Every takes writer stores through `store_take`: an insert takes the
write's declared tier and origin; an update (`addTakesBatch` in place, `updateTake`, both `supersedeTake` rows,
`resolveTake`) keeps the stored tier and origin unless `claim`, `kind` or `holder` changed, and then lowers them to
the write's. `readRowTrustRows` ([cli-reads-import.md](cli-reads-import.md)) and the fence guard's held-row read
`listHeldRows` ([trust.md](trust.md)) read them; the take reads return neither column, as PGLite's `takeRowToTake` does. The embedding write changes no trust column and stores
the record as it is.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.addTakesBatch(rows)` | number of rows sent. Inserts or, when one of the nine written columns is DISTINCT, updates in place (`updated_at` moves, `created_at` stays). `constraint_violation` for a `NOT NULL` column, `takes_weight_check`, the same key twice in one batch ("ON CONFLICT DO UPDATE command cannot affect row a second time") or a missing page (`takes_page_id_fkey`, raised after every row is read); `invalid_argument` for a NUL byte, an `int4` overflow or an `f32` overflow | `addTakesBatch` |
| `brain.listTakes(filter)` | `Take[]`: page/slug/holder/kind/active/resolved/allow-list/source filters, `since_on_or_before` (`since_date <= x`, nulls drop), sort by `since_date` (NULLS LAST, `oldest_first` flips), `weight DESC` or `created_at DESC`, then `id DESC`; `limit` (100 when absent) and `offset` (a non-number, negative or non-finite offset is `invalid_argument`) | `listTakes` |
| `brain.listActiveTakesForPages({ page_ids, allow_list })` | active takes of the pages, by page then row | `listActiveTakesForPages` |
| `brain.searchTakes({ query, limit, allow_list, source_ids, eligible_only, min_trust, suppress_flagged })` | `TakeHit[]`: active takes whose `word_similarity(query, claim) >= 0.6` (`pg_trgm` default), `score DESC, weight DESC`; `limit` 30 when absent | `searchTakes` |
| `brain.searchTakesVector(embedding, { limit, allow_list, source_ids, eligible_only, min_trust, suppress_flagged, exclude_private })` | `TakeHit[]`: active takes whose vector was written for their current claim, nearest by pgvector cosine distance first (`vectors.rs`, over the cached vector index), `score` = `(1 - distance)::real`; `limit` 30 when absent. `invalid_argument` for an empty query, more than 16000 elements, a NaN (sent as null) or infinite element, or a width other than a candidate take's vector ("different vector dimensions") | `searchTakesVector` |
| `brain.updateTake({ page_id, row_num, weight, since_date, source })` | `false` when no take; else COALESCEs the three columns, moves `updated_at`, `true`. `takes_weight_check` applies | `updateTake` |
| `brain.supersedeTake(input)` | `{ status: 'not_found' \| 'resolved' }`, or `{ status: 'ok', old_row, new_row }` with `new_row = max(row_num) + 1` on the page; the old row turns inactive with `superseded_by = new_row`. Both rows share one timestamp; the new take keeps the old take's source | `supersedeTake` |
| `brain.resolveTake({ page_id, row_num, resolution })` | `'not_found'`, `'resolved'` or `'ok'`. Writes only on `'ok'` with a resolution: `takes_resolution_consistency` (three-valued, as the CHECK: `correct` needs outcome not false, `incorrect` not true, `partial`/`unresolvable` null) then `takes_resolved_quality_values` | `resolveTake` |
| `brain.getScorecard(options)` | the raw scorecard row (`total_bets`, `resolved`, `correct`, `incorrect`, `partial`, `unresolvable_count`, `brier`); `domain_prefix` is a LIKE prefix (`\` escapes; a trailing `\` is `invalid_argument`) | `getScorecard` |
| `brain.getCalibrationCurve(options)` | `{ bucket_lo, bucket_hi, n, observed, predicted }[]` of resolved binary takes, by bucket; `bucket_size` outside `(0, 1]` is `invalid_argument` (the member sends 0.1 then) | `getCalibrationCurve` |
| `brain.addSynthesisEvidence(rows)` | number of new rows (an existing key is skipped). `int4` checks for every row first, then `NOT NULL` per row, then the two foreign keys over the inserted rows | `addSynthesisEvidence` |
| `brain.matchTakeRows(pageId, rows, limit)` | the row numbers of the page's takes whose claim, kind or holder differs from the fence row of the same number (`IS DISTINCT FROM`: a null fence field differs), ascending, at most `limit` (null is no limit, negative is `invalid_argument`). A take that two fence rows of its number both differ from is listed twice, as the join lists it | `matchTakeRows` |
| `brain.deleteTakeRows(pageId, rowNums)` | null. Deletes the page's takes at those row numbers with the evidence rows that cite them and their vectors; a null entry or a number with no take deletes nothing, an empty list writes nothing | `deleteTakeRows` |
| `brain.listHeldTakeRows({ ids, writer?, pending? })` | `{ id, trust_tier }[]` by id: of the listed takes, those a write may not delete or overwrite; see "Held takes" | `listHeldTakeRows` |

## Held takes

`listHeldTakeRows({ ids, writer?, pending? })` (capability `takes`; reference `engine-sql/trust-fence.ts`; code
`takes/held.rs`, napi `families/trust_fence.rs`, member `store-members/trust-fence.ts`) is the fence guard's read of
the takes a write may not delete or overwrite (`trust/fence-guard.ts` `heldRows` for `takes`, called by the takes
reconcile in `cycle/extract-takes.ts`). Of the listed ids, a take is held when its stored tier (stamped by
`store_take`) ranks above the writer, or, with `pending`, when a pending `forget` proposal targets it
(`trust/proposals.rs` `pending_forget` on table `takes`; a take that is only the related row, or a proposal on another
table with the same id, holds nothing). The writer is the named tier, a name that is no tier ranking 0 as the SQL rank
`CASE` does, else the store's write trust context (`fence_context()`, `unknown` when undeclared). Takes are keyed by
id, so each listed id is one lookup; `FOR UPDATE` needs nothing in a store with one writer. An id with no take, and an
empty list, read nothing. On PGLite and Postgres the statement is the one `heldRows` sent through `executeRaw`, byte
for byte (pinned by `test/engine-sql-held-take-rows-golden.test.ts`). Parity case:
`test/engine-parity/take-held-rows.test.ts`.

Read eligibility: `projectionEligibleSql('takes', ...)` always hides takes of soft-deleted pages, of pages
whose frontmatter has a `quarantine` key (any value), and rows in `needs_rederive`. Only a raw-SQL purge
writes `needs_rederive` and `executeRaw` refuses on Rust, so that clause never hides a row here. The
members send `eligible_only: true` for any eligibility object and the store applies the first two clauses.
`listTakes`, `searchTakes` and `searchTakesVector` also take `min_trust` (`eligibility.floor`: `trustFloorSql`, the take's stamped
tier at or above the floor) and `suppress_flagged` (`eligibility.suppressFlagged`: `activationSuppressedSql`
over the take's tier and its write-gate receipts), through `trust::TrustPolicy`.

Each `addTakesBatch` row runs `trust::check_insert` first, as the `BEFORE INSERT` trigger runs before
`ON CONFLICT` decides: a writer that declares a tier above `operator_curated` without owner confirmation is
refused even when the row is already current and nothing would be written.

Cascades: deleting a page (`remove_page_rows`) drops its takes, their evidence, and the evidence the page
cites as a synthesis page. `remove_source_rows` sweeps every take and evidence row of the source; page
deletes already cover them, so this is defensive.

Differences from PGLite:

- `searchTakes`: Postgres sorts by `score DESC, weight DESC` alone, so ties come in no fixed order. The store
  breaks ties by take `id` ascending.
- `searchTakesVector`: Postgres orders by distance alone, so ties come in no fixed order; the store puts NaN
  (a zero query vector) last and breaks ties by take `id` ascending. A NaN score crosses as null, where the
  SQL arms read NaN. Postgres refuses another width only for the rows its plan scans; the store refuses when a
  take that passes the filters has one.
- `getCalibrationCurve`: Postgres computes `FLOOR(weight::numeric / bucket_size)` with numeric division,
  which rounds to its working scale before `FLOOR`. The store divides exactly. The two differ only when the
  quotient lies within about 1e-16 of an integer without being one.
- `listTakes` sends a non-finite offset as a string, which the store refuses as `invalid_argument`; Postgres
  refuses it with its own error text.
- Timestamps are kept to the microsecond and cross as ISO strings; the member reads them back through
  `Date#toISOString`, as `takeRowToTake` does.

The eight single-purpose reads of doctor, onboarding, the fact purge, the fence import, the MCP scorecard and the take repair
(`countTakes`, `countOffGridTakeWeights`, `planFactPurgeTakes`, `listTakeRowsForPage`, `countMcpResolvedTakes`,
`listTakeSupersessionCandidates`) are in [takes-reads.md](takes-reads.md).
