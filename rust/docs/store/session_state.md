# The brain store: Session state

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Ambient recall keeps one row per `(source_id, client_id, session_id)` in `session_context_state` (migration v126):
`delta`'s page and fact cursors and its incomplete-wake counter, the context pack's standing entities, and the
compaction harvest's checkpoint manifest. `src/core/context/session-state.ts` reads and writes the row fail-open; the
TypeScript statements are in `src/core/engine-sql/session-state.ts`; the store module is
`rust/crates/gbrain-store/src/session_state.rs`.

Keys (tag `x`, `keys::SESSION_STATE`):

- `x 0x01 <source_id> 0x00 <client_id> 0x00 <session_id>` holds the row as JSON: `standing_entities`,
  `surfaced_slugs` and `checkpoint_manifest` (the JSON the caller sent), `last_wake_at_us`, `facts_cursor_at_us`,
  `facts_cursor_id`, `degraded_wakes`, `updated_at_us`.

The table has no foreign key, so page and source deletes leave the rows, as in Postgres; the GC ages them out.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readSessionContextState(sourceId, clientId, sessionId)` | `{ standing_entities, surfaced_slugs, last_wake_at }`, or null with no row | `readSessionContextState` |
| `brain.readDeltaSessionRow(sourceId, clientId, sessionId)` | `{ surfaced_slugs, last_wake_at, facts_cursor_at, facts_cursor_id, degraded_wakes }`, or null with no row | `readDeltaSessionRow` |
| `brain.readCheckpointManifest(sourceId, clientId, sessionId)` | `{ checkpoint_manifest }`, or null with no row | `readCheckpointManifest` |
| `brain.upsertSessionContextRow(sourceId, clientId, sessionId, { standing_entities, cursor_slug, last_wake_at, facts_cursor_at, facts_cursor_id, degraded_wakes })` | the stored `degraded_wakes`. A new row takes `standing_entities` (or `[]`), `[cursor_slug]` (or `[]`), the two times and the facts id, and 1 incomplete wake for `increment` (else 0). An existing row replaces standing entities and the surfaced slug only when given, keeps a stored time when the write has none, keeps the stored facts id when the write has no facts time, and counts `increment` up one, `reset` to 0, anything else kept. `updated_at` is the write time | `upsertSessionContextRow` |
| `brain.writeCheckpointManifest(sourceId, clientId, sessionId, manifest)` | nothing; replaces the manifest and `updated_at`, creating the row with the column defaults when there is none | `writeCheckpointManifest` |
| `brain.gcSessionContextRows(olderThanDays, maxRowsPerClient)` | nothing; deletes the rows not updated in `olderThanDays` days (a fraction is part of a day), then keeps the newest `maxRowsPerClient` rows of each `(source_id, client_id)` | `gcSessionContextRows` |

Times cross as ISO UTC text at microsecond precision (`2026-06-01T10:00:00.123456Z`), as the SQL's `to_char`
projects them; the write takes any text `timestamptz` accepts in the forms `parse_timestamptz` reads. Postgres breaks
an `updated_at` tie in the cap in no stated order; the store keeps the lower session id, in byte order. Text that
holds a NUL byte, in a key or in the JSON, is `invalid_argument`, as Postgres refuses it. A non-finite age is
`invalid_argument`, as the interval cast refuses it. An increment past the `integer` range is `invalid_argument`.

The parity cases are `test/engine-parity/session-state.test.ts`; the seven-day age, the cap order and the tie are
cargo tests (`rust/crates/gbrain-store/tests/session_state.rs`) with a fake clock.
