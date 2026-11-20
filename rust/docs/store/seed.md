# The brain store: Shadow seed

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The shadow seed copies a primary brain (PGLite or Postgres) into a fresh Rust store, so a shadow run starts from the
same data. `gbrain engine shadow seed` reads the primary in one read-only snapshot and sends each relation, in batches,
to `importRelation`. The method is a handle method (`RustStore.importRelation` in `src/core/rust-engine/store.ts`),
not a `BrainEngine` member, and no capability table lists it.

Rows keep what the primary gave them: ids, timestamps, revisions, incarnations, trust tiers and source ids. Each call
is one write transaction that goes through the family writers, so every index key a family keeps (slug index, link
index keys, timeline dedup key, take row key, chunk postings, vectors) is written the way that family's own writes
write it. Every id counter (pages, chunks, links, timeline entries, takes, facts) is raised past the highest id
copied, so a later write never reuses a copied id. A write stamps the seed trust: a backfill at `user_confirmed`.

Keys (tag `M`):

- `M shadow_seed` holds `{ seed_id, started_at_us, relations: { <relation>: { imported, skipped, dropped } } }`, the
  seed that owns the store and the running totals of each relation.

## Claiming the store

The first call of a seed writes the manifest. It is refused (`invalid_state`) unless the store is fresh: only the
records a new store holds (`Mformat`, `Cversion`, `Sdefault`). A later call is refused (`invalid_state`) unless it
carries the same seed id. So a second seed never lands on top of a first, and a retried batch of the same seed skips
the rows it already stored. A refused batch stores nothing, the manifest included. To seed again, the caller opens a
new store directory (`--reseed`).

## Rows

A row is `{ <column>: <text> | null }`: each column is the Postgres text of its value (`::text`, with the session
time zone at UTC). The decoders read `t`/`f` booleans, `YYYY-MM-DD HH:MM:SS[.f]+HH[:MM]` and ISO timestamps,
`YYYY-MM-DD` dates, JSON, `[a,b]` vectors and `{a,"b c"}` text arrays. A missing column reads as null. A value that
does not decode is `invalid_argument` with `seed <relation>.<column>`; every row error names the row
(`<relation> row <n>: ...`) and fails the whole batch.

The caller imports the relations in this order (`seed::RELATIONS`), because a row names rows of earlier relations:

| Relation | Kept | Notes |
| --- | --- | --- |
| `sources` | the source record | a row equal to the stored record is skipped; a different one replaces it (the fresh store holds `default`) |
| `config` | the key and value | a row equal to the stored value is skipped. `version` is never copied: a different value is dropped (`config_version_differs`), so the store keeps its own schema version |
| `pages` | the page record, its body state, salience, contextual-retrieval state, page signature, extraction record and projection job | an id already held is skipped; a slug held by another id is `constraint_violation`. The row also carries the page's `page_projection_jobs` row as `projection_job_revision`, `projection_job_reason` and `projection_job_updated_at` (a left join on the page's source incarnation and slug, null when the primary queued no job). A job row is stored with the primary's revision, reason and time |
| `tags` | the tag and its `tag_source` | the page's `updated_at` and revisions do not move |
| `content_chunks` | the chunk, its search meta, its vector and embedding state | a retired chunk (`retired_chunk`) and a body-segment chunk (`segment_chunk`) are dropped. An `embedding_text_hash` equal to the md5 of the chunk text becomes the store's own hash, so the chunk does not read as drifted; another hash is kept as it is |
| `links` | the link and its three index keys | both pages, and the origin page when set, must exist |
| `timeline_entries` | the entry and its dedup key | the page and the event page must exist |
| `slug_aliases`, `page_aliases` | the alias | a held alias is skipped |
| `facts` | the fact, its tier and its embedding | an id already held is skipped |
| `takes` | the take and its row key | `claim_rev` starts at 0. The vector is kept only when it is current (hash equals the md5 of the claim, model and `embedded_at` set) |

A row whose source or page is missing is `source_not_found` or `page_not_found`.

## What the seed does not keep

Nothing is dropped silently. `unmapped_columns` names each column that held a value other than its default in some
row and that the store does not keep (for example `pages.last_retrieved_at`, the `write_*` columns, tag and alias
ids, chunk `created_at`). `losses` counts, by reason, the rows dropped and the values the store could not carry:

| Reason | What was lost |
| --- | --- |
| `config_version_differs` | the primary's schema `version` |
| `segmented_body` | the segments of a segmented body (the page and its body columns are kept) |
| `emotional_weight_without_touch` | a non-zero weight on a page with no `salience_touched_at` |
| `corpus_generation_without_mode` | a corpus generation with no contextual-retrieval mode |
| `retired_chunk`, `segment_chunk` | the dropped chunk rows |
| `embedding_image`, `embedding_multimodal` | the chunk's image or multimodal vector |
| `projection_job_seed_time` | the time of a projection job the page write queued when the primary row gave no job time (no job row, or one with no `updated_at`): the job keeps the seed transaction's time |
| `vector_without_embedded_at` | the embed time of a vector with none (stored as time 0) |
| `take_vector_not_current` | a take vector that is not current |

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.importRelation(seedId, relation, rows)` | `{ imported, skipped, dropped, unmapped_columns, losses }` for the batch. `imported` counts rows stored (for `sources` and `config`, also rows that replaced a different value), `skipped` rows already held, `dropped` rows the store cannot hold. `invalid_argument` for an unknown relation, an empty seed id or a NUL byte; `invalid_state` for a store another seed owns or a store that is not fresh | none (the seed reads the primary's tables) |
