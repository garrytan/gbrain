# The brain store: Session state

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Session state is the `session_context_state` table: the session cursor of context_pack and delta and the session's
checkpoint manifest, one row per `(source_id, client_id, session_id)` under key tag `y`. It ports
`src/core/engine-sql/session-state.ts`; the caller is `src/core/context/session-state.ts`, which keeps its fail-open
behaviour on every engine. Key parts holding U+0000 are `invalid_argument`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.upsertSessionState(sourceId, clientId, sessionId, write)` | the row's `degraded_wakes` after the write. A new row takes the given values (`degraded_wakes` 1 for `increment`, else 0). An existing row replaces `standing_entities` and `surfaced_slugs` only when `replaceStanding` / `replaceCursorSlug` is set, keeps the stored `last_wake_at` and facts cursor when the new one is null, and adds one (`increment`), sets 0 (`reset`) or keeps the counter. Time text Postgres would refuse, a non-integral `factsCursorId` and U+0000 in a JSON value are `invalid_argument`, and nothing is written | `upsertSessionState` |
| `brain.readSessionCursor(sourceId, clientId, sessionId)` | `{ standing_entities, surfaced_slugs, last_wake_at }` or `null`; `last_wake_at` is microsecond ISO text or `null` | `readSessionCursor` |
| `brain.readDeltaSessionRow(sourceId, clientId, sessionId)` | `{ surfaced_slugs, last_wake_at, facts_cursor_at, facts_cursor_id, degraded_wakes }` or `null`; both times are microsecond ISO text or `null`, the id and counter are numbers | `readDeltaSessionRow` |
| `brain.readCheckpointManifestRow(sourceId, clientId, sessionId)` | `{ checkpoint_manifest }` or `null` | `readCheckpointManifestRow` |
| `brain.writeCheckpointManifest(sourceId, clientId, sessionId, manifest)` | `null`; replaces the manifest and `updated_at`, creating the row with column defaults when there is none | `writeCheckpointManifest` |
| `brain.ageOutSessionState(olderThanDays)` | `null`; deletes every row with `updated_at < now - olderThanDays days` | `ageOutSessionState` |
| `brain.capSessionStatePerClient(maxRowsPerClient)` | `null`; keeps the newest `maxRowsPerClient` rows of each `(source_id, client_id)` and deletes the rest | `capSessionStatePerClient` |

Every write sets `updated_at` to the store clock, which inside a transaction is the transaction's clock, as Postgres
`now()` is. JSON values read back in jsonb key order. The TypeScript members apply `wellFormedJson` before the call, so
a lone surrogate becomes U+FFFD as it does on Postgres.

A day in `ageOutSessionState` is 86,400 seconds. Postgres adds calendar days in the session time zone, so the two
differ by the daylight-saving shift for a row written within that hour of the cutoff in a zone that has one.

`capSessionStatePerClient` ranks rows as Postgres ranks `row_number() OVER (PARTITION BY source_id, client_id ORDER BY
updated_at DESC)`. Rows with equal `updated_at` (written in one transaction) tie, and Postgres's sort is not stable:
which tied rows survive depends on the order its sequential scan returns them. The store numbers every write
(`write_seq`) and sorts the rows in that order with the same algorithm Postgres runs in memory, so it keeps the rows
PGLite and a freshly written Postgres table keep. A Postgres table whose heap order no longer follows write order (after
page pruning or free-space reuse) can keep different tied rows; ties occur only among rows written in one transaction.
