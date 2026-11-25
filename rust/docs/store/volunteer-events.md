# The brain store: volunteered-page events

Part of the telemetry family ([telemetry.md](telemetry.md)); the rules in [rust/README.md](../../README.md) ("The brain
store") apply.

The store keeps `context_volunteer_events`: one row per page the proactive context volunteer offered
(`src/core/context/volunteer-events.ts`). The SQL for the PGLite and PostgreSQL engines is in
`src/core/engine-sql/volunteer-events.ts` (the insert's `VALUES` list built per row, as the caller built it; `VOLUNTEER_USAGE_SQL`); the store serves the same members
(`volunteer_events.rs`, keys `a 0x0C` for the events and `a 0x0D` for the id sequence).

| Member | Returns |
| --- | --- |
| `brain.insertVolunteerEvents(rows)` | null. Each row is `{ source_id, slug, confidence, match_arm, rationale, channel, session_id, turn }`. A row whose page row is gone is dropped; a soft-deleted page still counts (the SQL probe reads `pages` without a `deleted_at` filter). Every row is stamped now. A row holding a NUL byte refuses |
| `brain.listVolunteerChannels(sourceIds)` | `{ channel, n, last_fired }` per channel over the events of the last 7 days (of `sourceIds`, every source when null), by byte of channel; `last_fired` is the newest event's ISO time (doctor's `listVolunteerChannels`) |
| `brain.readVolunteerUsage(sourceIds, days)` | `{ match_arm, channel, volunteered, used }` per arm and channel over the events of `sourceIds` newer than `days` days, by byte of arm then channel (`COLLATE "C"`). `used` counts the events whose live page's retrieval record is later than the event |
| `brain.deleteVolunteerEventsOlderThan(ttlDays)` | the number of events older than `ttlDays` days, deleted (`volunteered_at < now() - interval`, the 90-day purge of the dream cycle's purge phase, `purgeStaleVolunteerEvents`); a day count that is not a number refuses with `invalid_argument` |
| `brain.deleteVolunteerEventsForSlugs(sourceId, slugs)` | the number of events of that source that name one of `slugs`, deleted (`deletePurgedNameStoreRows`, the name-store scrub of a page purge); no slug deletes nothing |

A hard page delete drops the page's events (`scrubPurgedNameStores`), and removing a source drops the source's events
(`removedSourceScrubCtes`), as on the SQL engines. A purge probe of `context_volunteer_events` searches the stored events,
and the receipt's `slug_key` probe of the store counts the events that still name the slug (`countPurgeProbe`).
