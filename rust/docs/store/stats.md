# The brain store: Statistics, health and the ingest log

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

This family answers `getStats`, `getHealth`, `listEnrichCandidates` and `findAnomalies` from the
records the other families keep (pages, chunks, links, tags, timeline entries, sources, config),
and keeps one table of its own: PGLite's `ingest_log`. The key tag is the reserved `n`;
`FORMAT_VERSION` stays 1.

| Key | Value | Mirrors |
| --- | --- | --- |
| `n created_at id` | `{ id, source_id, source_type, source_ref, pages_updated, summary, created_at_us }` (JSON) | one `ingest_log` row |

`created_at` is the row's microsecond timestamp as 8 bytes big-endian with the sign bit flipped,
so the byte order is the numeric order. `id` is 8 bytes big-endian from the `M next_ingest_log_id`
counter. One reverse scan of `n` reads `ORDER BY created_at DESC`; rows with the same microsecond
come back newer id first (PGLite leaves that tie unordered). The table has no foreign key in
PGLite, so deleting a page or a source leaves the log alone here too. `pages_updated` is stored as
PGLite's `jsonb` holds it: object keys sorted by length, then by bytes.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.logIngest({ source_id, source_type, source_ref, pages_updated_json, summary })` | nothing. The member sends `source_id ?? 'default'` and the text node-postgres binds for each value. A `null` column fails with `constraint_violation` and Postgres's not-null message, checked in column order; a NUL byte or a `pages_updated_json` that is not JSON fails with `invalid_argument`. Nothing is kept on a failure | `logIngest` |
| `brain.getIngestLog({ limit, sourceIds })` | the rows newest first, at most `limit` (the member sends `opts.limit \|\| 50`; rounded as Postgres casts it; a negative limit fails with `invalid_argument`), only the `sourceIds` when the list is not empty. The member turns `created_at` into a `Date` | `getIngestLog` |
| `brain.getStats({ scope })` | the `BrainStats` counters. `page_count` counts live pages; chunks, links, tags and timeline entries count the rows of pages in the scope, soft-deleted pages included, as the PGLite joins do. A scoped link needs both ends in the scope. `pages_by_type` is ordered by count, then type bytes | `getStats` |
| `brain.getHealth({ scope, entityTypes })` | raw counters: `page_count`, `eligible_chunks`, `embedded_chunks`, `missing_embeddings`, `dead_links`, `link_count`, the entity counters, `linkable` (every live, not quarantined page in the scope with `islanded` and `has_timeline`, before the orphan policy) and `most_connected` (top 5 by degree, then slug bytes) | the counting queries of `engine-sql/health.ts` |
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
- `resolveEntityTypes` runs one `executeRaw` for a brain-wide reading: the registered sources with
  a `schema_pack.source.<id>` config row. The Rust engine does not serve `executeRaw`, so the member
  passes a small engine shim that answers that one query from `listConfigKeys` and the source list.
  The shim matches the key as LIKE does (`_` matches any one character). Any other query throws,
  and `resolveEntityTypes` then reports `pack_unavailable`, as it does for a failed read on PGLite.
- `findAnomalies` computes the window bounds from `since` and `lookback_days` (an invalid `since`
  throws the same `RangeError`), zero-fills the store's day counts over the same days as
  `generate_series`, and runs `computeAnomaliesFromBuckets`. `excludePrivate` is refused: the store
  does not evaluate the private-page filter yet.
- `listEnrichCandidates` clamps `limit` and `thinThreshold` and turns `reenrichAfterMs` into the
  `enrichedAfter` text. An unknown `order` reads as `inbound-links`, as PGLite's lookup does.

## Differences and costs

- Embeddings. A chunk counts as embedded when it has a stored vector (`EmbedState::has_vector`), as
  PGLite counts `embedding IS NOT NULL` on the active column. `getStats` counts the chunks of every
  page in the scope, soft-deleted and `embed_skip` pages too; `getHealth` counts only the chunks of
  live pages without `embed_skip`, and `missing_embeddings` is the rest of those chunks. The store
  keeps one vector column, PGLite's `embedding`: `getStats` and `getHealth` refuse a brain whose
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

