# The brain store: takes, salience and code-edge reads

Part of the takes family ([takes.md](takes.md)); the rules in [rust/README.md](../../README.md) ("The brain store") apply.

Eight single-purpose reads that used to be raw SQL in doctor, onboarding, the fact purge, the fence import, the MCP
scorecard and the take repair. Each is now one engine member, with the SQL in `src/core/engine-sql/takes-reads.ts`
(PGLite and Postgres) and a native read in the store. A take is scoped by the page it hangs on, read now.

| Member | Returns | Used by |
| --- | --- | --- |
| `brain.countOffGridTakeWeights()` | `{ off_grid, total }` over every take: weights further than 0.001 from the 0.05 grid | doctor `takes_weight_grid` |
| `brain.countTakes()` | the number of takes | onboarding `checkTakesCount` |
| `brain.planFactPurgeTakes({ sourceId, factIds, factHash, subject })` | `[{ id, page_id }]` by id: takes of the source that the purged facts were consolidated into, or whose claim has the purged fingerprint on the subject's page (`*` is every page) | `planFactPurge` |
| `brain.listTakeRowsForPage(pageId)` | `[{ row_num, claim }]` by row number (the SQL gained an `ORDER BY row_num`; it was unordered) | fence import `storedFenceRows` |
| `brain.countMcpResolvedTakes({ sourceIds, holders, excludePrivate })` | resolved takes whose `resolved_by` starts with `mcp:`, on a page in the source scope, held by a listed holder | `countMcpResolved` |
| `brain.listTakeSupersessionCandidates(sourceIds)` | `[{ id, source_id, slug }]` by page id: live pages with an inactive take or a source cell saying `superseded by #` (any case) | take supersession repair |
| `brain.countZeroWeightWithTakes()` | `{ zero_weight_with_takes, nonzero_weight }`: pages with an active take and weight 0 (never weighed reads 0), and pages with weight above 0; soft-deleted pages count | doctor `salience_health` |
| `brain.hasCodeEdgesSymbol(sourceId)` | whether the source owns an unresolved (symbol-table) edge | `symbol-resolver` |

Differences from PGLite and PostgreSQL:

- `countMcpResolvedTakes` with `excludePrivate: true` stops with `engine_capability_missing`: the private-page filter is a
  caller-policy SQL fragment the store does not model. Callers that hit it rethrow the refusal.
- The weight grid check is exact integer arithmetic on the six-significant-digit decimal that `weight::numeric` of a
  `real` prints, so it agrees with Postgres at the 0.001 boundary and at half-way rounding. A weight with more than 30
  places is within 1e-30 of zero, which is on the grid.
- The typed write API snaps every weight to the grid, so an off-grid weight can only come from a raw insert; the boundary
  is pinned by `rust/crates/gbrain-store/tests/takes_reads.rs` and `test/engine-sql-takes-reads.test.ts`, not by the
  parity test.
