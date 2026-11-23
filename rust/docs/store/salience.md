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
- `excludePrivate` (any truthy value, as `pageReadFilter` tests it) applies the page policy on both reads; see
  "Private pages" below. The input carries the policy as
  `exclude_private` (`{ honorAliases, entityPrivacy, ownerOnly }`); a page it hides, an owner-only page included, is
  not scored or ranked. A read finds the owner-only sources once, on the first page it judges (`OwnerOnlyCache`).
- `minTrust` and `suppressFlagged` apply on `getSalienceScores` (its SQL applies `pageEligibleSql`) through
  `trust::TrustPolicy`: the page's stamped tier at or above the floor, and no instruction-family write-gate receipt on
  an agent-written-or-lower page. On `getRecentSalience` they change nothing, as its SQL never reads them.
- `getSalienceScores` applies the live clauses whenever a read policy object is passed (`pageReadFilter(..., !!scope)`).
  Hybrid search passes its whole `SearchOpts` as the policy; the keys the SQL does not read are ignored.
- `setEmotionalWeightBatch` refuses a NaN or infinite weight (JSON cannot carry it; PGLite stores it as a `real`).

## Private pages (`excludePrivate`)

PGLite adds `privatePagesFilterForCaller('p')` (`src/core/search/private-visibility.ts:631`) through
`pageReadFilter` (`src/core/search/read-policy-sql.ts:27`) on both reads: `getRecentSalience` at
`src/core/engine-sql/salience.ts:152`, and `getSalienceScores` (`src/core/pglite-engine.ts:2073`) through
`readSalienceScores` at `src/core/search/read-enrichment.ts:322-325`. With no caller record
(`currentCallerAccess`, `private-visibility.ts:392`: restricted, no identity) the filter is the member-access part
(`callerAccessSql`, 584: `readersAllowedSql`, 171; `folderRulesAllowedSql`, 133, with `coverageSql`, 146;
`originAllowedSql`, 197) and, unless privacy is relaxed (`callerPrivacySql`, 626), the privacy part
(`privacyPartSql`, 89).

The store copies it with `page_hidden` (`facts/privacy.rs`), lane 4's private-provenance rules applied to the read's
own page: a page is hidden when it names readers, when a non-plain page's origin names readers, or, with
`entityPrivacy`, when its snapshot, derived origin or declared lineage is private (the rules table in
[facts.md](facts.md#private-provenance-policy-factsprivacyrs)). A page under a folder rule of its source
(`folder_rule_ids IS NOT NULL`) passes only when the caller satisfies every rule on it, and a page under a pending
prefix passes only when the caller's record names no coverage of it (the store's own pending rows count only for a
caller with no record). The filter drops a page before `getRecentSalience` ranks and limits.

The member (`store-members/private-provenance.ts` `storePagePolicy`) renders `privatePagesFilterForCaller('p')` in
the current context and outside any caller record. Both reads opt in with `callerReaders`: when the two differ, the
member renders the policy again for a record of only the caller's reader identity and private-readable grant, and when
the caller's text equals that, it also sends `identity` and `privateReadableSources`, which `page_hidden` reads (a page
whose readers name a principal of the identity, and a non-pinned page of a granted source, pass) with the folder
rules it satisfies (`satisfiedRuleIds`) and the pending prefixes its record holds (`folderCoverage`). Any other caller
(lineage, an owner read) refuses with `engine_capability_missing`. The member sends
`honorAliases` (the text holds `privacyAliasSql('p')`, 791) and `entityPrivacy` (the text holds
`privateSnapshotFilterFragment('p')`, 707, which is absent when privacy is relaxed).

## Cascades

- Hard page delete: `remove_page_rows` drops the page's record.
- Source delete: core removes each page of the source first, so the page hook covers it.

## Differences from PGLite

- `getRecentSalience` ties: the SQL leaves equal scores unordered; the store orders them by `(source_id, slug)`.
- `batchLoadEmotionalInputs` row order and the order of a page's takes are unspecified in SQL; the store returns pages
  in key order and takes by row number.
- The score uses the store clock once per read for `now` (Postgres `now()` is the transaction start); the recency term
  then matches within 1e-6.

`countZeroWeightWithTakes()` (the doctor's `salience_health` counts) is documented in [takes-reads.md](takes-reads.md).
