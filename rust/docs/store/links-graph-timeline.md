# The brain store: Links, graph and timeline

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Links and timeline entries are typed key-value records with their own index keys. Every write
changes a record and all of its index keys in one transaction, so a crash keeps all of them or
none (the simulation below checks this). The new key tags are additive; `FORMAT_VERSION` stays 1.

| Key | Value | Mirrors |
| --- | --- | --- |
| `L from_page_id link_id` | the link record (JSON) | a `links` row, stored under the page it leaves |
| `l to_page_id link_id` | `from_page_id` | the backlink index |
| `O origin_page_id link_id` | `from_page_id` | the links a page authored (`origin_page_id`) |
| `U from to link_type \0 link_source origin` | `link_id` | `UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id)`; a NULL source or origin has its own encoding |
| `E page_id date entry_id` | the entry record (JSON) | a `timeline_entries` row; one reverse scan is `ORDER BY date DESC, id DESC` |
| `D page_id date sha256(summary) source` | `entry_id` | the `(page_id, date, md5(summary), source)` dedup index (another digest, the same rule) |
| `G page_id` | newest `created_at` of the page's entries | what `stale` compares with |

Ids are integers from a counter, like a Postgres serial. A timeline add that hits the dedup key still
takes an id, as `INSERT .. ON CONFLICT DO NOTHING` does, so the ids `getTimeline` returns match
PGLite. `deletePage` removes the links that leave or reach the page and its timeline entries
(`ON DELETE CASCADE`) and clears the origin of links it authored (`ON DELETE SET NULL`). When that
clear would collide with another link, `deletePage` rejects `constraint_violation` and changes
nothing, as PGLite does. A soft-deleted page hides every edge it touches, as an endpoint or as
the origin.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.addLink(from, to, { context?, linkType?, linkSource?, originSlug?, originField?, fromSourceId?, toSourceId?, originSourceId? }?)` | `null`. The positional arguments of `addLink` in one object. Repeating a link updates its context. `page_not_found` for a missing endpoint; `constraint_violation` for a `linkSource` outside PGLite's CHECK; a missing origin is dropped (`origin_slug` `null`, `origin_field` kept) | `addLink` |
| `brain.addLinksBatch(links)` | inserted count; rows with a missing endpoint are skipped | `addLinksBatch` |
| `brain.removeLink(from, to, { linkType?, linkSource?, fromSourceId?, toSourceId? }?)` | removed count. An absent filter matches every value; `null` matches nothing, as `= NULL` does | `removeLink` |
| `brain.getLinks(slug, { sourceId?, sourceIds? }?)` / `brain.getBacklinks(...)` | `{ from_slug, from_source_id, to_slug, to_source_id, link_type, context, link_source, origin_slug, origin_source_id, origin_field }[]`; slugs match exactly | `getLinks` / `getBacklinks` |
| `brain.traverseGraph(slug, depth?, { sourceId?, sourceIds?, frontierCap? }?)` | `{ slug, source_id, title, type, depth, links: [{ to_slug, link_type }] }[]`, outgoing walk, default depth 5, each page once at its shallowest depth, at most 20,000 pages | `traverseGraph` |
| `brain.traversePaths(slug, { depth?, direction?, linkType?, sourceId?, sourceIds? }?)` | `{ from_slug, from_source_id, to_slug, to_source_id, link_type, context, depth }[]`; `direction` `out` (default), `in` or `both`; each edge once | `traversePaths` |
| `brain.traversePathsDetailed(slug, opts?)` | `{ paths, truncated }`; at most 5,000 edges, `truncated` when more exist | `traversePathsDetailed` |
| `brain.addTimelineEntry(slug, { date, summary, source?, detail? }, { sourceId?, skipExistenceCheck? }?)` | `true` when a row was written, `false` for a duplicate (same page, date, summary and source) | `addTimelineEntry` |
| `brain.addTimelineEntriesBatch(entries)` | inserted count; entries of missing pages are skipped | `addTimelineEntriesBatch` |
| `brain.getTimeline(slug, { limit?, after?, before?, sourceId?, sourceIds? }?)` | `{ id, page_id, date, source, summary, detail, event_page_id, created_at }[]`, `date DESC, id DESC`, default `limit` 100, `0` for all | `getTimeline` |

Where this engine differs from PGLite:

- `traversePathsDetailed` orders by `(depth, from_slug, to_slug, from_source_id, to_source_id)` as
  PGLite does, then by `link_type` and link id where PGLite's order is undefined. Two links that
  differ only in origin show once, the one with the lowest id.
- Dates: `YYYY-MM-DD` or `YYYY/MM/DD`, optionally followed by `T` or a space and a time that is
  ignored (`2026-01-05T23:30:00-05:00` is `2026-01-05`, as in PGLite). Other spellings Postgres
  casts are refused `invalid_argument`, as is a date that does not exist.
- `getTimeline` rows carry the `TimelineEntry` fields only, not the write-provenance and
  `trust_tier` columns of the table (PGLite returns them `null` and `"unknown"` for these writes).
- `excludePrivate: true`, `temporal`, `page` (keyset paging of paths) and `eligibility` reject
  `invalid_argument` instead of being ignored. The TypeScript shell must not send them here.

`crates/gbrain-store/tests/graph_parity.rs` replays PGLite's own results for links, the graph
walks at depth 0 to 3 and past (cycles, direction, scope, soft delete, caps), timeline writes and
reads, and `stale`, and compares every step exactly. The fixture is
`tests/fixtures/graph-parity.json`, written by `bun rust/scripts/graph-parity-golden.ts` from the
repository root; `--check` fails when it is stale. Rebuild it when PGLite's behavior changes. The
fixture is part of the build hash; `rust/scripts/` is not.
