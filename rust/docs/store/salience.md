# The brain store: Salience

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Salience keeps the two page columns the `recompute_emotional_weight` cycle phase writes (`emotional_weight`,
`salience_touched_at`) and serves the reads that rank pages by them. The TypeScript members
(`src/core/rust-engine/store-members/salience.ts`) do what the shared SQL module (`src/core/engine-sql/salience.ts`,
`readSalienceScores` in `src/core/search/read-enrichment.ts`) does before its statement runs: the window boundary
(`Date.now() - days * 86400000`, at ms precision), the limit clamp (`clampSearchLimit(limit, 20, 100)`), the
`briefings/` rule, the recency map (`resolveRecencyDecayMap()` and `DEFAULT_FALLBACK` for `recency_bias: 'on'`), the
`updated_at` `Date` and the score `Map`.

Keys (tag `s`, `keys::SALIENCE`):

- `s <page id u64 BE>` holds `{ emotional_weight, touched_at_us }` once a weight was ever set. A page without a
  record reads the column defaults: weight 0, no touch time.

The record is keyed by page id: a rename keeps it and `putPage` leaves it alone, as an `UPDATE` of the content
columns leaves `emotional_weight` alone in Postgres. A weight write does not move `updated_at` (the Postgres triggers
bump nothing for these columns). `getPage`, `readPageSnapshot` and `listPages` read the record through the
page-columns hook: `emotional_weight` as the shortest text of the f32, `salience_touched_at` as ISO.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.batchLoadEmotionalInputs(slugs \| null)` | `{ slug, source_id, tags, takes }[]` for every page, or every page whose slug is listed (any source, soft-deleted pages too; `[]` lists none). `tags` distinct in byte order, `takes` the active takes as `{ holder, weight, kind, active }`. Pages in key order (the SQL has no ORDER BY) | `batchLoadEmotionalInputs` |
| `brain.setEmotionalWeightBatch(rows)` | number of pages changed. A row whose `(slug, source_id)` names no page is skipped; a page whose stored weight equals the new one (after f32 rounding; NaN equals NaN) is not rewritten or counted; a page listed twice is updated once, by its first row. A changed page gets `salience_touched_at = now`. `constraint_violation` for a null weight on a page that exists (`NOT NULL`); `invalid_argument` for a NUL byte or an f32 overflow/underflow | `setEmotionalWeightBatch` |
| `brain.getRecentSalience({ boundary_ms, limit, slug_prefix, exclude_briefings, source_ids, holders, recency })` | `SalienceResult[]` (dates as ISO). Live pages (not soft-deleted, no `quarantine` frontmatter key, source not archived) touched at or after the boundary, in scope, matching the literal slug prefix, not under `briefings/` when asked. `score = emotional_weight * 5 + ln(1 + active takes) + recency`, best first; equal scores fall back to `(source_id, slug)` in byte order | `getRecentSalience` |
| `brain.getSalienceScores({ refs, source_ids, holders, live })` | `{ slug, source_id, score }[]`, one per listed page that exists (exact `(slug, source_id)`) and passes the scope, and the live clauses when `live`. `score = emotional_weight * 5 + ln(1 + active takes)` | `getSalienceScores` |

Touch time: an unrestricted read takes `max(updated_at, salience_touched_at ?? updated_at)` for the window. A
restricted read (`takesHoldersAllowList` set, `holders` here; an empty list allows no holder) takes `updated_at`,
reports `emotional_weight` 0, drops the weight term and counts only the allowed holders' active takes.

Recency (`buildRecencyComponentSql`): `days_old = (now - date) / 86400 s`, where `date` is `updated_at` (flat) or
`COALESCE(effective_date, updated_at)` (`'on'`). The first branch whose prefix starts the slug (the member sends them
longest first) gives `(h, c)`, else the fallback; the term is 0 when `h` or `c` is 0, else `c * h / (h + days_old)`.
Flat is the fallback `(1, 1.0)` with no branches.

Numbers: arithmetic widens the f32 weight to a double first, as Postgres does for `real * 5` and `AVG(real)`.
`take_avg_weight` is the average of the widened take weights (0 with no takes).

## Read policy

- Source scope: a non-empty `sourceIds` wins over a truthy `sourceId`; neither is no scope.
- `takesHoldersAllowList`: honoured (see above).
- `excludePrivate` on `getSalienceScores` is the page policy `pageReadFilter` adds, judged by `page_hidden` in
  `facts/privacy.rs`: the input carries it as `exclude_private` (`{ honorAliases, entityPrivacy, ownerOnly }`) and a page it
  hides, an owner-only page included, is not scored. The member sends it through `storePagePolicy`, which refuses a caller whose policy is wider
  than the store's. On `getRecentSalience` it refuses with `engine_capability_missing`: the caller's privacy filter
  (`privatePagesFilterForCaller`) is not applied there.
- `minTrust` and `suppressFlagged` refuse on `getSalienceScores` (its SQL applies `pageEligibleSql`); on
  `getRecentSalience` they change nothing, as its SQL never reads them.
- `getSalienceScores` applies the live clauses whenever a read policy object is passed (`pageReadFilter(..., !!scope)`).
  Hybrid search passes its whole `SearchOpts` as the policy; the keys the SQL does not read are ignored.
- `setEmotionalWeightBatch` refuses a NaN or infinite weight (JSON cannot carry it; PGLite stores it as a `real`).

## Cascades

- Hard page delete: `remove_page_rows` drops the page's record.
- Source delete: core removes each page of the source first, so the page hook covers it.

## Differences from PGLite

- `getRecentSalience` ties: the SQL leaves equal scores unordered; the store orders them by `(source_id, slug)`.
- `batchLoadEmotionalInputs` row order and the order of a page's takes are unspecified in SQL; the store returns pages
  in key order and takes by row number.
- The score uses the store clock once per read for `now` (Postgres `now()` is the transaction start); the recency term
  then matches within 1e-6.
