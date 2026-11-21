# timeline_queries: the Life Chronicle reads and the timeline site reads

Code: `rust/crates/gbrain-store/src/timeline_queries.rs`, the napi methods in
`rust/crates/gbrain-napi/src/families/timeline_queries.rs` and the members in
`src/core/rust-engine/store-members/timeline-queries.ts`. The reference is
`src/core/engine-sql/timeline.ts`; for the site reads (`timeline_queries/site_reads.rs`) it is
`src/core/engine-sql/timeline-reads.ts`.

## Members

| Member | State |
|---|---|
| `getTimelineForDate(date, { week?, limit?, sourceId?, sourceIds? })` | served |
| `getSince(date, { kind?, limit?, sourceId?, sourceIds? })` | served |
| `getOnThisDay({ date?, limit?, sourceId?, sourceIds? })` | served |
| `getLastSeen(entitySlug, { asof?, sourceId?, sourceIds? })` | served; the TypeScript member adds `days_ago` with the shared `finalizeLastSeen` |
| `upsertEventProjection({ depthSlug, eventSlug, date, summary, detail?, sourceId? })` | served, through the core helpers `next_entry_id`, `read_entry` and `put_entry` |
| `removeTimelineRows(pageId, rows)` | served, through `remove_entry` and `recompute_latest` |
| `updateTimelineDetails(pageId, rows)` | served, through `put_entry` |
| `insertCanonicalTimelineRows(pageId, rows)` | served, through `insert_entry` |
| `sampleEffectiveDates()` | served (site read) |
| `sampleEffectiveDateSources()` | served (site read) |
| `readMaxTimelineEntryId()` | served (site read) |
| `listStoredTimelineRowsOrdered(pageId)` | served (site read) |
| `deleteTimelineRows(pageId, deletions)` | served (site write) |
| `storedTimelineRowsByPageIds(pageIds)` | served (site read) |
| `countSegmentedTimelinePages(sourceIds, limit)` | served (site read) |
| `countTimelineCommentMarkupRows(sourceIds)` | served (site read) |
| `listTimelineOrphanPages({ afterId, limit, sourceId? })` | served (site read) |

`excludePrivate` is served on the four chronicle reads. The TypeScript member reads the page policy from the rendered
SQL (`storePagePolicy`) and passes it as `excludePrivate`. A caller whose record holds only a reader identity and a
private-readable grant is served with both (the `callerReaders` opt-in); it refuses any other caller whose policy
differs (folder grants, lineage, an owner read). Under the policy a row drops when `privatePagesFilterForCaller('p')` hides its depth page, or when
`privateTimelineEventFilterForCaller('te')` hides its event page (`page_hidden` in facts/privacy.rs for both). The
event test is an `EXISTS` on the event page by id with no source scope, so an event page outside the scope (whose
fields the join nulls out) still hides the row when the policy hides it. `requireSafeChunks`, `minTrust` and
`suppressFlagged` are ignored, because the SQL reads ignore them too.

## The shared join

Every read takes each timeline entry, joins its page `p` (which must not be soft-deleted) and, for an event
projection, LEFT JOINs its event page `ep`:

- Source scope: a non-empty `sourceIds` beats a non-empty `sourceId`, which beats no scope. The scope filters `p`.
  It is also a condition of the `ep` join, so an event page outside the scope reads as no event page: the row stays,
  with `event_slug`, `effective_date` and `kind` null (`event_page_id` keeps its value).
- A soft-deleted event page in scope hides the row.
- An entry whose event page is gone is skipped: Postgres removes it with `ON DELETE CASCADE`.

Row: `date` (`YYYY-MM-DD`), `summary`, `detail`, `source`, `trust_tier` (the tier the
entry's last write stamped, links-graph-timeline.md), `page_id`, `page_slug`, `event_page_id`, `event_slug`, `effective_date` (`timestamptz::text` in UTC, for
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

## upsertEventProjection

The SQL is `INSERT ... SELECT` from the depth page and the event page of one source (`sourceId`, default `default`)
`ON CONFLICT (event_page_id, date) DO UPDATE` of summary, detail, page and source. The store follows it:

- `{ projected: false }` when either page is missing. Soft-deleted pages still project: the SQL has no `deleted_at`
  test. A bad date fails with `invalid_argument` before the pages are looked up, as the constant cast does.
- The entry's source is `life-chronicle:event:<eventSlug>` and its detail is `detail ?? ''`.
- The serial is taken whenever both pages exist, the update path included; the update keeps the entry's id and
  `created_at` and can move it to another depth page.
- A new or updated entry whose `(page, date, summary, source)` matches another entry is `constraint_violation`
  (`idx_timeline_dedup`), and the write keeps nothing.
- Text with a NUL byte is `invalid_argument`.

## removeTimelineRows, updateTimelineDetails and insertCanonicalTimelineRows

The fence projection's three statements over `jsonb_to_recordset` (`engine-sql/timeline.ts`). The delete and the update reach only the
page's own entries (`event_page_id` is null) and find them by id: the store has no id index, so it scans the
page's `E` keys.

- `removeTimelineRows(pageId, rows)` deletes a row only while the stored `date`, `source`, `summary` and `detail`
  all equal the row's. A null field equals nothing, so that row stays. It returns `[{ date, removed }]` for the
  deleted rows in the order `rows` names them (the order PGLite returns; the caller only collects the dates). A row
  named twice is deleted and returned once. Every `date` is read as a date before anything is deleted, so a bad
  one is `invalid_argument` for the whole call (`YYYY/MM/DD` is a date). An empty list, a negative page id and a
  row of another page change nothing.
- Each delete removes the `E` key and the `D` key when it still points at the entry, so the same entry can be
  added again. `G` is then set again to the newest `created_at` of the entries the page still has (event
  projections included), or deleted when none is left, as `max(created_at)` follows the rows.
- `updateTimelineDetails(pageId, rows)` sets `detail` to `next` while the stored detail equals the row's `detail`
  (null equals nothing). A row named twice applies once, the first. A null `next` on a matching row is
  `constraint_violation` (`detail` is `NOT NULL`) and the call keeps nothing. The entry keeps its id, date,
  source, summary and `created_at`; the write goes through `put_entry`, so `G` is not lowered.
- `insertCanonicalTimelineRows(pageId, rows)` inserts the rows as the page's own entries in `rows` order, through
  `insert_entry` (the `ON CONFLICT (page_id, date, md5(summary), source) DO NOTHING` insert): a row equal on date,
  summary and source to a stored entry, or to an earlier row of the call, is skipped and still takes an id. A
  soft-deleted page takes rows. A missing page is `constraint_violation` (the foreign key), a null column
  `constraint_violation` and a bad date `invalid_argument`; each writes nothing. An empty list changes nothing.
- Text with a NUL byte is `invalid_argument`.

## The site reads

The statements doctor, the canonical projection, `gbrain repair timeline` and the orphan prune ran through
`engine.executeRaw`. None applies a read policy, so the members take none. An own row is one with no event page.
A live page is one that is not soft-deleted. A segmented page has NULL `compiled_truth` and `timeline`.

- `sampleEffectiveDates`: of the newest 1000 pages by id, soft-deleted pages included, `future_dated` counts an
  effective date after the store clock plus one calendar year (UTC, the time of day kept, February 29 to February 28).
  `pre_1990` counts a date before `1990-01-01` whose source is not `event_date`, `date`, `published` or `created`.
- `sampleEffectiveDateSources`: the same sample, source `fallback`, with a frontmatter key `event_date`, `date` or
  `published`, newest id first. The member turns `created_at` and `updated_at` into `Date`s.
- `readMaxTimelineEntryId`: the largest id of any `E` record, event rows included, or 0. It reads the keys, not the
  id counter, so it matches `max(id)` after a delete.
- `listStoredTimelineRowsOrdered`: the page's own rows in `E` key order (date, then id).
- `deleteTimelineRows`: one write, the same statement as `removeTimelineRows`, which the canonical projection calls. Each deletion's date is parsed as the `date` column parses it; a bad date fails
  with `invalid_argument` before any row is read. An own row of the page is deleted when a deletion matches its id,
  date, source, summary and detail (a missing field matches nothing). It returns `{ date, removed }` per deleted row,
  in key order. The `E` key goes, and the `D` key when it still names the row. `G` of the page is then reset to the
  newest `created_at` of the rows left, or removed, so the keyword stale flag follows `MAX(created_at)`.
- `storedTimelineRowsByPageIds`: own rows of the named pages, by page id, then id. A negative id matches nothing.
- `countSegmentedTimelinePages`: live segmented pages of the sources with own rows, their row total and the first
  `limit` of them by id.
- `countTimelineCommentMarkupRows`: own rows on live pages of the sources whose summary or source holds `<!--` or
  `-->`.
- `listTimelineOrphanPages`: live pages with an id after `afterId`, in `sourceId` when it is not empty, that hold own
  rows, by id, at most `limit`. `body_storage` is `segmented` for a segmented page, else `inline`; `revision` is the
  knowledge revision.

The members refuse with `engine_capability_missing` a value the SQL engines would fail to bind: a page or row id
that is not a 32-bit integer, a page id or `afterId` that is not an integer, and a limit that is negative or not an
integer.

## Keys

The reads write nothing and scan every `E` record. The family keeps one index, in place of `idx_timeline_event_dedup`:

`u 0x01 <event_page_id be8> <date>` -> `<page_id be8> <entry id be8>`

A lookup reads the named entry back and treats the row as absent when that entry is gone or no longer names the
event page (the hard delete of its depth page removes the entry and leaves the row). `remove_event_projections`
(called by the core `remove_page`, `ON DELETE CASCADE`) deletes the entries an event page's rows name, with their
`E` and `D` keys, and the rows. Entries written by any other path are not in the index.

## Known differences

- The core latest-entry marker `G` only goes up, except that `removeTimelineRows` and `deleteTimelineRows` set it
  again after their deletes. A projection moved to another depth page leaves `G` of the old page where it was, while
  Postgres computes the newest `created_at` each time. No parity case reads that today.
- Fence-guard's held-row count (`heldRows` for `timeline_entries`) stays on the SQL path; the store now keeps the
  row tier it needs. Follow-up: `timeline-held-rows-typed`.
- Time zone: the store reads `current_date`, `te.date::timestamptz` and `effective_date::text` in UTC (the frozen
  contract). PGLite follows the process time zone; `bun test` pins it to UTC. Follow-up:
  `chronicle-reads-host-time-zone`.

## Follow-ups

- `timeline-held-rows-typed`: fence-guard's held-row count (`heldRows` for `timeline_entries`) refuses on Rust and
  stays on the SQL path. The record now carries the stamped tier, so this is done when `heldRows` for
  `timeline_entries` is a typed member served from the store and a parity case compares a held row on every arm.
- `chronicle-reads-host-time-zone`: see Known differences.
