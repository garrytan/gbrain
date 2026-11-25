# The brain store: Links, graph and timeline

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Links and timeline entries are typed key-value records with their own index keys. Every write
changes a record and all of its index keys in one transaction, so a crash keeps all of them or
none (the simulation below checks this). The new key tags are additive and took no format number; the store is at format 7 now
([format.md](format.md)).

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
| `brain.readNewestTimelineEntryId(sourceId, slug, date, summary)` | the id of the newest entry of the page (soft-deleted or not) on `date` whose summary is `summary`, event rows included; `null` when the page or such an entry is missing. A bad date is refused `invalid_argument` | `readNewestTimelineEntryId` |
| `brain.getTimeline(slug, { limit?, after?, before?, sourceId?, sourceIds?, excludePrivate?, eligibleOnly? }?)` | `{ id, page_id, date, source, summary, detail, event_page_id, created_at, write_request_id, write_principal_kind, write_principal_id, last_write_request_id, last_write_principal_kind, last_write_principal_id, last_written_at }[]`, `date DESC, id DESC`, default `limit` 100, `0` for all | `getTimeline` |

Where this engine differs from PGLite:

- `traversePathsDetailed` orders by `(depth, from_slug, to_slug, from_source_id, to_source_id)` as
  PGLite does, then by `link_type` and link id where PGLite's order is undefined. Two links that
  differ only in origin show once, the one with the lowest id.
- Dates: `YYYY-MM-DD` or `YYYY/MM/DD`, optionally followed by `T` or a space and a time that is
  ignored (`2026-01-05T23:30:00-05:00` is `2026-01-05`, as in PGLite). Other spellings Postgres
  casts are refused `invalid_argument`, as is a date that does not exist.
- Write receipts: every timeline write stamps the entry's seven attribution columns as PGLite's
  `gbrain_stamp_write_attribution` trigger does (`timeline/receipt.rs`). An insert under a principal
  (`gbrain.write_principal_kind` set in the write context, [write_trust.md](write_trust.md)) takes the
  request and the principal in `write_*` and `last_*` and the transaction time in `last_written_at`; an
  insert with no principal stamps nothing. An update keeps `write_*`, and moves `last_*` and
  `last_written_at` only when the content (id, page, date, source, summary, detail, event page,
  `created_at`) changed; a changed row with no principal clears `last_*`. A record stored before the
  receipt reads every receipt column null. `getTimeline` returns the seven columns (`last_written_at` ISO).
- Timeline trust: each write stamps `trust_tier` and `write_origin` through `trust::stamp`
  (`timeline/tier.rs`), as PGLite's `trust_tier_stamp` trigger does. An insert takes the write's declared
  tier (`unknown` when none) and the context's origin. An update starts from the stored tier and origin
  and lowers them to the write's only when `summary`, `detail` or `date` changed. The tier is a
  `serde(default)` field of the `E` record, omitted while it is `unknown` with no origin, so a record
  stored before it reads `"unknown"` and `null`. `getTimeline` returns both columns.
- On the link and graph reads, `excludePrivate: true`, `temporal` and `page` (keyset paging of
  paths) reject `invalid_argument` instead of being ignored, and so does a raw `eligibility` value
  on `getTimeline`. The TypeScript shell must not send them here.
- `getTimeline` serves `excludePrivate`. The TypeScript member reads the page policy from the
  rendered SQL (`storePagePolicy`) and passes it as `excludePrivate`. A caller whose record holds
  only a reader identity and a private-readable grant is served with both (the `callerReaders`
  opt-in); it refuses any other caller whose policy differs (folder grants, lineage, an owner read). Under the policy a page that
  `privatePagesFilterForCaller('p')` hides reads no rows. An entry drops when
  `privateTimelineEventFilterForCaller('te')` hides its event page (`page_hidden` in
  facts/privacy.rs). That filter is an `EXISTS` on the event page id alone, so an event page in
  another source or soft-deleted is still judged, and an entry whose event page is gone drops.
  The filter runs before `limit`.
- `getTimeline` serves an `eligibility` policy without `floor` or `suppressFlagged`. The
  TypeScript member sends `eligibleOnly: true` for any policy object, and the store applies the
  base clauses of `projectionEligibleSql('timeline_entries', 'te', ..)`: every row hangs on its
  depth page (`te.page_id`), so a soft-deleted page, or a page whose frontmatter has a
  `quarantine` key (any value), reads no rows. The `needs_rederive` clause hides a row a purge marked (`generations/needs_rederive.rs`). The
  filter runs before `limit`. Without a policy a soft-deleted page still reads its rows, as the SQL
  has no `deleted_at` test. A policy `floor` drops a row whose stored tier ranks below it, and
  `suppressFlagged` drops a row at or below `agent_written` with a `flag` write-gate receipt
  (`target_table` `timeline_entries`) in an activation family (`TrustPolicy::admits`,
  trust/eligibility.rs). Both run before `limit`.

`crates/gbrain-store/tests/graph_parity.rs` replays PGLite's own results for links, the graph
walks at depth 0 to 3 and past (cycles, direction, scope, soft delete, caps), timeline writes and
reads, and `stale`, and compares every step exactly. The fixture is
`tests/fixtures/graph-parity.json`, written by `bun rust/scripts/graph-parity-golden.ts` from the
repository root; `--check` fails when it is stale. Rebuild it when PGLite's behavior changes. The
fixture is part of the build hash; `rust/scripts/` is not.
