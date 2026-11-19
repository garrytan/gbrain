# timeline_queries: the Life Chronicle reads

Code: `rust/crates/gbrain-store/src/timeline_queries.rs`, the napi methods in
`rust/crates/gbrain-napi/src/families/timeline_queries.rs` and the members in
`src/core/rust-engine/store-members/timeline-queries.ts`. The reference is
`src/core/engine-sql/timeline.ts`.

## Members

| Member | State |
|---|---|
| `getTimelineForDate(date, { week?, limit?, sourceId?, sourceIds? })` | served |
| `getSince(date, { kind?, limit?, sourceId?, sourceIds? })` | served |
| `getOnThisDay({ date?, limit?, sourceId?, sourceIds? })` | served |
| `getLastSeen(entitySlug, { asof?, sourceId?, sourceIds? })` | served; the TypeScript member adds `days_ago` with the shared `finalizeLastSeen` |
| `upsertEventProjection(opts)` | refused: it writes core `E`/`D`/`G` records and waits on the core timeline write helpers (`next_entry_id`, `put_entry`, `read_entry`) on `rust-engine-core-hooks` |

`excludePrivate: true` refuses: the SQL engines apply a privacy filter for it. `requireSafeChunks`, `minTrust` and
`suppressFlagged` are ignored, because the SQL reads ignore them too.

## The shared join

Every read takes each timeline entry, joins its page `p` (which must not be soft-deleted) and, for an event
projection, LEFT JOINs its event page `ep`:

- Source scope: a non-empty `sourceIds` beats a non-empty `sourceId`, which beats no scope. The scope filters `p`.
  It is also a condition of the `ep` join, so an event page outside the scope reads as no event page: the row stays,
  with `event_slug`, `effective_date` and `kind` null (`event_page_id` keeps its value).
- A soft-deleted event page in scope hides the row.
- An entry whose event page is gone is skipped: Postgres removes it with `ON DELETE CASCADE`.

Row: `date` (`YYYY-MM-DD`), `summary`, `detail`, `source`, `trust_tier` (always `unknown`, as the store keeps no
tier), `page_id`, `page_slug`, `event_page_id`, `event_slug`, `effective_date` (`timestamptz::text` in UTC, for
example `2026-06-18 09:00:00.25+00`) and `kind` (`frontmatter->'event'->>'kind'`: a string as is, another value as
its jsonb text, JSON null as null).

## Order and limits

- `getTimelineForDate`: one day, or with `week` the Monday to Sunday that holds it. `getSince`: `date` and later,
  only events of `kind` when `kind` is set. Both order by `COALESCE(ep.effective_date, date at midnight UTC)`, then
  entry id, and default to 200 rows.
- `getOnThisDay`: the month and day of `date` (today in UTC when absent) in earlier years, `date DESC, id ASC`,
  50 rows by default.
- `getLastSeen`: entries on or before `asof` (today in UTC when absent) on the entity's own page, or whose event's
  `event.who` array has an element equal to the slug or holding `[[slug]]` or `[[slug|`. The newest by
  `date DESC, COALESCE(effective_date, date) DESC, id DESC` wins.
- `limit: 0` returns nothing and a negative limit is `invalid_argument`, as Postgres `LIMIT` is.
- A date that the core `parse_date` refuses is `invalid_argument`.

## Keys

The reads write nothing and scan every `E` record. upsertEventProjection will add the event index
`u 0x01 <event_page_id be8> <date>` -> entry id under this family's tag, and `remove_event_projections(tx, page_id)`
(called by the core `remove_page`) will delete the projections of a removed event page through it.

## Known differences

- Time zone: the store reads `current_date`, `te.date::timestamptz` and `effective_date::text` in UTC (the frozen
  contract). PGLite follows the process time zone; `bun test` pins it to UTC. Follow-up:
  `chronicle-reads-host-time-zone`.
