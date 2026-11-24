# The brain store: maintenance sweep reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the page reads that the maintenance sweep (`src/core/sweep.ts`) ran through `executeRaw`.
PGLite and Postgres run the same SQL as before, now in `src/core/engine-sql/sweep-reads.ts`.
The store answers from its page records, the extraction watermarks of [extraction.md](extraction.md) and the
body states and manifests of [page_body.md](page_body.md) (`crates/gbrain-store/src/cli_reads/sweep_reads.rs`),
and has no keys of its own.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listFactsFencePages({ sourceId, since, scanCap, limit })` | of the newest `scanCap` live pages of the source updated at or after `since`, the slugs of those whose compiled truth holds `gbrain:facts:begin` or that are segmented with a published manifest row whose `facts_slots` is not `[]`; newest first, at most `limit` | `listFactsFencePages` |
| `brain.listSweepStalePages({ sourceId, since, limit, exclude })` | live pages of the source updated at or after `since` whose `links_extracted_at` is absent or older than `updated_at`, less the `exclude` slugs, newest first, at most `limit`: `{ slug, read_at, updated_at_iso, body_storage, body_bytes }`. `read_at` is the transaction clock and `updated_at_iso` the page's `updated_at`, both `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC; a page with no body state reads `inline` and `null` | `listSweepStalePages` |
| `brain.listSweepDeferredPages({ sourceId, since, slugs })` | of the `slugs`, the live pages of the source updated at or after `since` that are still link-stale: `{ slug, updated_at_iso }`; an empty list reads nothing | `listSweepDeferredPages` |
| `brain.listPageRefsForSlugs({ slugs })` | the live pages of any source whose slug is in `slugs`, by source then slug: `{ slug, source_id, type, knowledge_revision }`; an empty list reads nothing, and a slug named twice reads its pages once (`slug = ANY($1::text[])`). The SQL leaves the rows in no set order | `listPageRefsForSlugs` |

`since` is an ISO 8601 UTC string; any other shape refuses `invalid_argument`, as does a negative `scanCap` or
`limit`. Pages with the same `updated_at` are ordered by page id, newest first; the SQL leaves that tie in no set order.
Each read scans every page record and filters in memory: the store has no `(source_id, updated_at)` index.
