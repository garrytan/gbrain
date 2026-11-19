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

`<row>` is `(row_num as u32 ^ 0x8000_0000)` big-endian, so negative row numbers sort first. A take keeps
the `source_id` of its page and a `claim_rev` that moves each time the claim text changes (for the
embedding staleness check owned by core).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.addTakesBatch(rows)` | number of rows sent. Inserts or, when one of the nine written columns is DISTINCT, updates in place (`updated_at` moves, `created_at` stays). `constraint_violation` for a `NOT NULL` column, `takes_weight_check`, the same key twice in one batch ("ON CONFLICT DO UPDATE command cannot affect row a second time") or a missing page (`takes_page_id_fkey`, raised after every row is read); `invalid_argument` for a NUL byte, an `int4` overflow or an `f32` overflow | `addTakesBatch` |
| `brain.listTakes(filter)` | `Take[]`: page/slug/holder/kind/active/resolved/allow-list/source filters, `since_on_or_before` (`since_date <= x`, nulls drop), sort by `since_date` (NULLS LAST, `oldest_first` flips), `weight DESC` or `created_at DESC`, then `id DESC`; `limit` (100 when absent) and `offset` (a non-number, negative or non-finite offset is `invalid_argument`) | `listTakes` |
| `brain.listActiveTakesForPages({ page_ids, allow_list })` | active takes of the pages, by page then row | `listActiveTakesForPages` |
| `brain.searchTakes({ query, limit, allow_list, source_ids, eligible_only })` | `TakeHit[]`: active takes whose `word_similarity(query, claim) >= 0.6` (`pg_trgm` default), `score DESC, weight DESC`; `limit` 30 when absent | `searchTakes` |
| `brain.updateTake({ page_id, row_num, weight, since_date, source })` | `false` when no take; else COALESCEs the three columns, moves `updated_at`, `true`. `takes_weight_check` applies | `updateTake` |
| `brain.supersedeTake(input)` | `{ status: 'not_found' \| 'resolved' }`, or `{ status: 'ok', old_row, new_row }` with `new_row = max(row_num) + 1` on the page; the old row turns inactive with `superseded_by = new_row`. Both rows share one timestamp; the new take keeps the old take's source | `supersedeTake` |
| `brain.resolveTake({ page_id, row_num, resolution })` | `'not_found'`, `'resolved'` or `'ok'`. Writes only on `'ok'` with a resolution: `takes_resolution_consistency` (three-valued, as the CHECK: `correct` needs outcome not false, `incorrect` not true, `partial`/`unresolvable` null) then `takes_resolved_quality_values` | `resolveTake` |
| `brain.getScorecard(options)` | the raw scorecard row (`total_bets`, `resolved`, `correct`, `incorrect`, `partial`, `unresolvable_count`, `brier`); `domain_prefix` is a LIKE prefix (`\` escapes; a trailing `\` is `invalid_argument`) | `getScorecard` |
| `brain.getCalibrationCurve(options)` | `{ bucket_lo, bucket_hi, n, observed, predicted }[]` of resolved binary takes, by bucket; `bucket_size` outside `(0, 1]` is `invalid_argument` (the member sends 0.1 then) | `getCalibrationCurve` |
| `brain.addSynthesisEvidence(rows)` | number of new rows (an existing key is skipped). `int4` checks for every row first, then `NOT NULL` per row, then the two foreign keys over the inserted rows | `addSynthesisEvidence` |

Read eligibility: `projectionEligibleSql('takes', ...)` always hides takes of soft-deleted pages, of pages
whose frontmatter has a `quarantine` key (any value), and rows in `needs_rederive`. Only a raw-SQL purge
writes `needs_rederive` and `executeRaw` refuses on Rust, so that clause never hides a row here. The
members send `eligible_only: true` for any eligibility object and the store applies the first two clauses.
`eligibility.floor` and `eligibility.suppressFlagged` refuse with `engine_capability_missing`.

Cascades: deleting a page (`remove_page_rows`) drops its takes, their evidence, and the evidence the page
cites as a synthesis page. `remove_source_rows` sweeps every take and evidence row of the source; page
deletes already cover them, so this is defensive.

Differences from PGLite:

- `searchTakes`: Postgres sorts by `score DESC, weight DESC` alone, so ties come in no fixed order. The store
  breaks ties by take `id` ascending.
- `getCalibrationCurve`: Postgres computes `FLOOR(weight::numeric / bucket_size)` with numeric division,
  which rounds to its working scale before `FLOOR`. The store divides exactly. The two differ only when the
  quotient lies within about 1e-16 of an integer without being one.
- `listTakes` sends a non-finite offset as a string, which the store refuses as `invalid_argument`; Postgres
  refuses it with its own error text.
- Timestamps are kept to the microsecond and cross as ISO strings; the member reads them back through
  `Date#toISOString`, as `takeRowToTake` does.
