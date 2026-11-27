# The brain store: Statistics, health and the ingest log

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

This family answers `getStats`, `getHealth`, `countOnboardSignal`, `countBrainLivePages`, `countLivePagesBySource`, `countChunksBySource`, `readBrainMaturity`, `listEnrichCandidates` and
This family answers `pingStore`, `getStats`, `getHealth`, `countOnboardSignal`, `readBrainMaturity`, `listEnrichCandidates` and
`findAnomalies` from the
records the other families keep (pages, chunks, links, tags, timeline entries, sources, config),
and keeps one table of its own: PGLite's `ingest_log`. The key tag is the reserved `n`. It took no format
number; the store is at format 14 now ([format.md](format.md)).

| Key | Value | Mirrors |
| --- | --- | --- |
| `n created_at id` | `{ id, source_id, source_type, source_ref, pages_updated, summary, created_at_us, writer_version, writer_host_id, writer_segment_reader }` (JSON) | one `ingest_log` row |

`created_at` is the row's microsecond timestamp as 8 bytes big-endian with the sign bit flipped,
so the byte order is the numeric order. `id` is 8 bytes big-endian from the `M next_ingest_log_id`
counter. One reverse scan of `n` reads `ORDER BY created_at DESC`; rows with the same microsecond
come back newer id first (PGLite leaves that tie unordered). The table has no foreign key in
PGLite, so deleting a page or a source leaves the log alone here too. `pages_updated` is stored as
PGLite's `jsonb` holds it: object keys sorted by length, then by bytes. The writer stamp (`writer_version`,
`writer_host_id`, `writer_segment_reader`, migration v254) is what the segmented-storage gate reads
(persistence.md, "Writer versions"); a row stored before the store kept it reads as unstamped and
without the mark, as an older binary's row reads on Postgres. `getIngestLog` does not return it.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.logIngest({ source_id, source_type, source_ref, pages_updated_json, summary, writer_version, writer_host_id, writer_segment_reader })` | nothing. The member sends `source_id ?? 'default'`, the text node-postgres binds for each value and the logging binary's stamp (`writerStamp({ mint: false })`); a record written before the stamp reads it as null, and a `writer_host_id` that is not a uuid refuses with the uuid syntax message. A `null` column fails with `constraint_violation` and Postgres's not-null message, checked in column order; a NUL byte or a `pages_updated_json` that is not JSON fails with `invalid_argument`. Nothing is kept on a failure | `logIngest` |
| `brain.getIngestLog({ limit, sourceIds })` | the rows newest first, at most `limit` (the member sends `opts.limit \|\| 50`; rounded as Postgres casts it; a negative limit fails with `invalid_argument`), only the `sourceIds` when the list is not empty. The member turns `created_at` into a `Date` | `getIngestLog` |
| `brain.pingStore()` | nothing, once the store opens a read snapshot; a closed store fails with `store_closed`. The member rejects an aborted `signal` with `AbortError` before the call | `pingStore` (`SELECT 1`) |
| `brain.getStats({ scope })` | the `BrainStats` counters. `page_count` counts live pages; chunks, links, tags and timeline entries count the rows of pages in the scope, soft-deleted pages included, as the PGLite joins do. A scoped link needs both ends in the scope. `pages_by_type` is ordered by count, then type bytes | `getStats` |
| `brain.getHealth({ scope, entityTypes })` | raw counters: `page_count`, `eligible_chunks`, `embedded_chunks`, `missing_embeddings`, `dead_links`, `link_count`, the entity counters, `linkable` (every live, not quarantined page in the scope with `islanded` and `has_timeline`, before the orphan policy) and `most_connected` (top 5 by degree, then slug bytes) | the counting queries of `engine-sql/health.ts` |
| `brain.countOnboardSignal({ signal, entityTypes })` | one count, brain-wide (no source scope, no quarantine filter): `stale_chunks` counts chunks with no stored vector on live pages without `embed_skip`; `entities` live pages of an entity type (`entityTypes.per_source` replaces `types` for its source); `linked_entities` and `timeline_entities` those with any inbound link or any timeline entry; `takes` every take; any other signal live pages, as the last arm of the SQL does | `countOnboardSignal` |
| `brain.countBrainLivePages()` | live pages in every source (no source scope), for backup coverage | `countBrainLivePages` |
| `brain.liveCountsBySource()` | `{ source_id, pages, chunks, embedded }` per source with a live page, in source id byte order: its live pages, their chunks and the chunks with a stored vector (no source scope), for `gbrain sources status`. `countLivePagesBySource` reads `pages`; `countChunksBySource` reads `chunks` and `embedded` and skips a source with no chunk, as the SQL join does. The store holds one vector column, so `column` must name the text column | `countLivePagesBySource`, `countChunksBySource` |
| `brain.readBrainMaturity()` | `{ pages, facts, since }`: live pages and unexpired facts in every source, and the earliest `created_at` of any source or page (soft-deleted pages count), null when there is neither; for backup coverage | `readBrainMaturity` |
| `brain.listEnrichCandidates({ types, thinThreshold, order, limit, enrichedAfter, scope })` | `{ slug, source_id, title, type, body_len, inbound_count }` rows. Live pages of the types in the scope, shorter than `thinThreshold` characters (`compiled_truth` plus `timeline`), not `dream_generated`, not enriched after `enrichedAfter`. Inbound links skip `link_source = 'mentions'` and `link_type = 'amends'` | `listEnrichCandidates` |
| `brain.findAnomalies({ scope, baselineStartUs, sinceUs, sinceEndUs })` | `{ baseline: { tag, type }, today }`: per cohort, the distinct pages updated on each UTC day of the baseline window, and the cohorts of the pages updated in the `since` day with their slugs. Only live, not quarantined pages of a source that exists and is not archived | the two bucket queries of `findAnomalies` |

## What the TypeScript members do

`src/core/rust-engine/store-members/stats.ts` keeps the parts PGLite runs in TypeScript, so the
two engines share that code instead of copying it:

- `getHealth` loads the orphan policy overrides, the timeline grading predicate, the entity types
  (`resolveEntityTypes`) and the link-extraction watermark through `getConfig`. It counts stale
  pages with `countStalePagesForExtraction` (per source when scoped), applies
  `shouldExcludeFromOrphanReporting` to `linkable`, and computes the coverage, the five score parts
  and `brain_score` with the arithmetic of `engine-sql/health.ts`.
- `resolveEntityTypes` reads the registered sources with a `schema_pack.source.<id>` config row for a
  brain-wide reading. The Rust engine does not serve `executeRaw`, so the member passes an engine of
  `kind: 'rust'` and the resolver answers from `listConfigKeys` and the source list (the key matches as LIKE
  does: `_` matches any one character). Any other raw query refuses with `engine_capability_missing`, and
  `resolveEntityTypes` then reports `pack_unavailable`, as it does for a failed read on PGLite.
- `findAnomalies` computes the window bounds from `since` and `lookback_days` (an invalid `since`
  throws the same `RangeError`), zero-fills the store's day counts over the same days as
  `generate_series`, and runs `computeAnomaliesFromBuckets`. `excludePrivate` (any truthy value) applies
  PGLite's `pageReadFilter('p', { excludePrivate }, [], true)` (`src/core/engine-sql/salience.ts:271`) to the
  baseline cohort keys, the baseline day counts and today's counts alike: the store skips each page that
  `page_hidden` (`facts/privacy.rs`) hides, as described in [salience.md](salience.md#private-pages-excludeprivate).
  A caller whose record holds only a reader identity and a private-readable grant is served with both (the
  `callerReaders` opt-in of `storePagePolicy`); any other caller record that changes
  `privatePagesFilterForCaller('p')` refuses with `engine_capability_missing`.
- `listEnrichCandidates` clamps `limit` and `thinThreshold` and turns `reenrichAfterMs` into the
  `enrichedAfter` text. An unknown `order` reads as `inbound-links`, as PGLite's lookup does.
  `order: 'owner-contact'` refuses with `engine_capability_missing`: the store has no owner-contact
  ranking yet, and a silent inbound-links answer would mislead.

## Differences and costs

- Embeddings. A chunk counts as embedded when it has a stored vector (`EmbedState::has_vector`), as
  PGLite counts `embedding IS NOT NULL` on the active column. `getStats` counts the chunks of every
  page in the scope, soft-deleted and `embed_skip` pages too; `getHealth` counts only the chunks of
  live pages without `embed_skip`, and `missing_embeddings` is the rest of those chunks. The store
  keeps one vector column, PGLite's `embedding`: `getStats`, `getHealth` and the `stale_chunks`
  count of `countOnboardSignal` refuse a brain whose
  config names another column (`search_embedding_column`, `embedding_columns`), as the embedding
  members do, instead of counting the wrong column.
- Salience order. `order: 'salience'` reads `emotional_weight` from the salience family
  (`salience::emotional_weight`): the stored weight, else 0, the PGLite column default.
- Segmented pages. Chunk counts include every chunk record of a page, staged segment chunks too,
  as PGLite counts every `content_chunks` row. A segmented page (NULL body) is never an enrich
  candidate: PGLite's `char_length(compiled_truth)` is NULL for it.
- Order. Text ties sort by bytes (`COLLATE "C"`). Anomaly cohorts come out in cohort value byte
  order; PGLite's `GROUP BY` order is not specified. `computeAnomaliesFromBuckets` sorts by
  `sigma_observed` and keeps the input order for equal values, so only rows with the same sigma
  can come out in a different order than on PGLite.
- Cost. Every member reads the whole page set. `getStats` and `getHealth` read the timeline of
  each page in the scope through the timeline family, one prefix scan per page. This is fine at
  the parity sizes; a brain with many thousand pages will want a per-page count record.


## Page visibility and version history reads (`src/core/engine-sql/admin-reads.ts`)

Two members for statements `src/core/ops/admin.ts` ran as raw SQL: `listVisiblePageSlugs` (the slugs `visibleMostConnected`
may show, under the read or access policy and an optional source scope) and `readPagesForVersionHistory` (the page rows
by id that `get_versions` resolves). Their capability in `members.ts` is `pages`.

`readPagesForVersionHistory` is served: `Store::read_pages_for_version_history` (`gbrain-store/src/tail_reads.rs`, see
`tail_reads.md`) reads the page record of each id: `id`, `slug`, `source_id` and `frontmatter`, in id order, each id once,
soft-deleted pages included (the statement does not filter them). An unknown or negative id names no row.

`listVisiblePageSlugs` is served: `Store::list_visible_page_slugs` (`gbrain-store/src/cli_reads/admin_reads.rs`, see
`admin-reads.md`) keeps the slugs of the live pages in the given sources that the caller's page policy (read or access
form, as the typed store policy) does not hide, in byte order.

The policy text is Postgres text only; the store reads the typed arguments, never the statement.
