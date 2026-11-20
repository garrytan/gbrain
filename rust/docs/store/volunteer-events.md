# The brain store: volunteered-page events

Part of the telemetry family ([telemetry.md](telemetry.md)); the rules in [rust/README.md](../../README.md) ("The brain
store") apply.

The store keeps `context_volunteer_events`: one row per page the proactive context volunteer offered
(`src/core/context/volunteer-events.ts`). The SQL for the PGLite and PostgreSQL engines is in
`src/core/engine-sql/collate-store-reads.ts` (`VOLUNTEER_SQL`); the store serves the same members
(`volunteer_events.rs`, keys `a 0x0C` for the events and `a 0x0D` for the id sequence).

| Member | Returns |
| --- | --- |
| `brain.insertVolunteerEvents(rows)` | null. Each row is `{ source_id, slug, confidence, match_arm, rationale, channel, session_id, turn }`. A row whose page row is gone is dropped; a soft-deleted page still counts (the SQL probe reads `pages` without a `deleted_at` filter). Every row is stamped now. A row holding a NUL byte refuses |
| `brain.readVolunteerUsage(sourceIds, days)` | `{ match_arm, channel, volunteered, used }` per arm and channel over the events of `sourceIds` newer than `days` days, by byte of arm then channel (`COLLATE "C"`). `used` counts the events whose live page's retrieval record is later than the event |

Not served: the 90-day purge `purgeStaleVolunteerEvents` (an `executeRaw` statement, which a Rust brain refuses).
