# The brain store: context-volunteer events

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The `context_volunteer_events` table of the SQL engines (migration v117) is the log of every page the brain volunteered
(`src/core/context/volunteer-events.ts`). PGLite and Postgres run the same SQL as before (`src/core/engine-sql/volunteer-events.ts`,
`doctor-acc.ts` for the channel listing). The TypeScript side is `src/core/rust-engine/store-members/volunteer-events.ts` and
`doctor-acc.ts`; the store side is `crates/gbrain-store/src/volunteer_events.rs`.

## Records

| Key | Holds | SQL table |
| --- | --- | --- |
| `M volunteer_event \0 source \0 slug \0 <id, 20 digits>` | `{ id, source_id, slug, confidence, match_arm, rationale, channel, session_id, turn, volunteered_at_us }` | `context_volunteer_events` |

The id is the table's `BIGSERIAL` (the counter `next_volunteer_event_id` under `META`), so a slug's rows list in the order they were written.

## Members

| Member | Serves |
| --- | --- |
| `insertVolunteerEventRows` | the multi-row insert of `insertVolunteerEvents`. A row is written only when its page exists, deleted or not (the SQL's `EXISTS (SELECT 1 FROM pages ...)`), so a write built before a page purge and landing after it drops that page's slug and rationale (#9068). A NUL byte in any text refuses the whole batch with `invalid_argument`, as one statement fails whole. |
| `listVolunteerChannels` | the events of the last 7 days (`volunteered_at > now() - interval '7 days'`) per channel, in byte order of the channel, scoped to `sourceIds` or brain-wide when null. `last_fired` crosses the binding as an ISO string and comes back as a `Date`. |
| `listVolunteerUsage` | `volunteerUsageStats`: per `(match_arm, channel)` in byte order, the events of the sources in the last N days and those whose live page was retrieved after the event. The store keeps no legacy `pages.last_retrieved_at` column, so the page's retrieval record (`bumpPageRetrievals`) is the whole `GREATEST(...)`. Counts are text, as `count(*)::text`. |
| `deleteVolunteerEventsOlderThan` | the 90-day retention delete of the dream purge phase; a day count that is not a number refuses. |

Two statements of the volunteer log are served through members that already exist for them: the name-store scrub of a page
purge is `deletePurgedNameStoreRows` (the store deletes the slugs' rows, `delete_volunteer_events_for_slugs`, and the gazetteer
count stays 0), and the page purge receipt's `context_volunteer_events` check is the `countPurgeStoreProbe` of a `slug_key`
probe (`facts/purge_store_probe.rs`, `count_for_slug`).

## Scrubs

A row names a page by source and slug outside any foreign key, and its rationale quotes the matched name, so every hard
delete removes it:

- `deletePages` and `purgeDeletedPages` run the slug scrub after the delete (`page_ops.rs` `scrub_purged_slugs`), in PGLite's order
  (`scrubPurgedSlugs`, `scrubPurgedNameStores`, `scrubPurgedSlugStores`).
- `deleteSourceRecord` removes the source's rows through `cascade::remove_source_rows`, as the SQL engines' `scrub_context_volunteer_events` does.
- A soft delete keeps the rows, because `restore_page` can bring the page back.
- The fact purge verification's inventory probe of `context_volunteer_events` (the `rationale` column) searches the rows
  (`facts/purge_probe.rs`), so a row that still carries a purged claim is reported as the SQL engines report it.
