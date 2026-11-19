/**
 * Ambient recall session state (`session_context_state`, migration v126): the per-session cursor the `delta` verb and
 * the context pack keep, the checkpoint manifest the compaction harvest banks, and the row GC. These statements ran
 * through `engine.executeRaw` in context/session-state.ts; they now run once here for both engines.
 *
 * The key is `(source_id, client_id, session_id)`, passed whole on every call; the caller (context/session-state.ts)
 * normalizes it (the 'local' client sentinel, the id length cap). The table carries no read policy, so the reads run
 * unscoped. jsonb binds through `$N::text::jsonb` (the cast parses the text). The callers stay fail-open: an error here
 * reaches them, and they turn it into absence, `unavailable` or a false publish.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';

/** One session row's key, already normalized by the caller. */
export interface SessionStateKey { sourceId: string; clientId: string; sessionId: string }

/**
 * The context pack's view of a session row. The jsonb columns come back as the engine's driver reads them (an array,
 * or its text); the caller keeps the strings. `last_wake_at` is ISO UTC at microsecond precision.
 */
export interface SessionContextStateRow { standing_entities: unknown; surfaced_slugs: unknown; last_wake_at: string | null }

/** delta's view of a session row: both cursors (ISO UTC, microseconds) and the incomplete-wake counter. */
export interface DeltaSessionRow {
  surfaced_slugs: unknown;
  last_wake_at: string | null;
  facts_cursor_at: string | null;
  facts_cursor_id: number | null;
  degraded_wakes: number;
}

/**
 * One upsert of the session cursor. A null field keeps the stored value on an update (an insert writes `[]`, null or 0
 * for it). `standingEntities` and `cursorSlug` replace their column when not null; `cursorSlug` is stored as the
 * one-element `surfaced_slugs` array. `lastWakeAt` and `factsCursorAt` are timestamp text. `factsCursorId` is kept with
 * the stored id when `factsCursorAt` is null. `degradedWakes` adds one, sets 0 or keeps the counter.
 */
export interface SessionContextWrite {
  standingEntities: string[] | null;
  cursorSlug: string | null;
  lastWakeAt: string | null;
  factsCursorAt: string | null;
  factsCursorId: number | null;
  degradedWakes: 'increment' | 'reset' | 'keep';
}

// ISO UTC at the column's microsecond precision (not ::text: PGLite renders local-tz text, and a JS Date round-trip
// would re-round the keyset cursor to milliseconds, re-delivering same-millisecond pages).
const READ_STATE_SQL = `SELECT standing_entities, surfaced_slugs,
              to_char(last_wake_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_wake_at
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`;

const READ_DELTA_SQL = `SELECT surfaced_slugs, to_char(last_wake_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_wake_at,
              to_char(facts_cursor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS facts_cursor_at, facts_cursor_id, degraded_wakes
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`;

const READ_MANIFEST_SQL = `SELECT checkpoint_manifest
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`;

// Single statement: keep-if-absent and the counter run inside the UPDATE, so concurrent pack and delta writers cannot
// wipe banked entities or lose an increment.
const UPSERT_STATE_SQL = `INSERT INTO session_context_state
         (source_id, client_id, session_id, standing_entities, surfaced_slugs, last_wake_at,
          facts_cursor_at, facts_cursor_id, degraded_wakes, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb, $6::text::timestamptz, $9::text::timestamptz, $10::bigint,
               CASE WHEN $11::text = 'increment' THEN 1 ELSE 0 END, now())
       ON CONFLICT (source_id, client_id, session_id) DO UPDATE SET
         standing_entities = CASE WHEN $7::boolean THEN EXCLUDED.standing_entities
                                  ELSE session_context_state.standing_entities END,
         surfaced_slugs    = CASE WHEN $8::boolean THEN EXCLUDED.surfaced_slugs
                                  ELSE session_context_state.surfaced_slugs END,
         last_wake_at      = COALESCE(EXCLUDED.last_wake_at, session_context_state.last_wake_at),
         facts_cursor_at   = COALESCE(EXCLUDED.facts_cursor_at, session_context_state.facts_cursor_at),
         facts_cursor_id   = CASE WHEN EXCLUDED.facts_cursor_at IS NULL THEN session_context_state.facts_cursor_id
                                  ELSE EXCLUDED.facts_cursor_id END,
         degraded_wakes    = CASE $11::text WHEN 'increment' THEN session_context_state.degraded_wakes + 1
                                            WHEN 'reset' THEN 0
                                            ELSE session_context_state.degraded_wakes END,
         updated_at        = now()
       RETURNING degraded_wakes`;

const WRITE_MANIFEST_SQL = `INSERT INTO session_context_state
         (source_id, client_id, session_id, checkpoint_manifest, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, now())
       ON CONFLICT (source_id, client_id, session_id) DO UPDATE SET
         checkpoint_manifest = EXCLUDED.checkpoint_manifest,
         updated_at          = now()`;

const GC_AGE_SQL = `DELETE FROM session_context_state WHERE updated_at < now() - ($1 || ' days')::interval`;

// Per-client LRU cap: keep the newest rows per (source_id, client_id).
const GC_CAP_SQL = `DELETE FROM session_context_state s
       USING (
         SELECT source_id, client_id, session_id,
                row_number() OVER (
                  PARTITION BY source_id, client_id ORDER BY updated_at DESC
                ) AS rn
         FROM session_context_state
       ) ranked
       WHERE s.source_id = ranked.source_id
         AND s.client_id = ranked.client_id
         AND s.session_id = ranked.session_id
         AND ranked.rn > $1`;

const keyParams = (k: SessionStateKey) => [k.sourceId, k.clientId, k.sessionId];

/** The context pack's read of one session row; null when there is no row. */
export async function readSessionContextState(exec: LegacyUnscopedRead, key: SessionStateKey): Promise<SessionContextStateRow | null> {
  const [r] = await exec.executeRaw<{ standing_entities: unknown; surfaced_slugs: unknown; last_wake_at: string | null }>(READ_STATE_SQL, keyParams(key));
  return r ? { standing_entities: r.standing_entities, surfaced_slugs: r.surfaced_slugs, last_wake_at: r.last_wake_at ?? null } : null;
}

/** delta's read of one session row; null when there is no row (a first wake). */
export async function readDeltaSessionRow(exec: LegacyUnscopedRead, key: SessionStateKey): Promise<DeltaSessionRow | null> {
  const [r] = await exec.executeRaw<{
    surfaced_slugs: unknown; last_wake_at: string | null; facts_cursor_at: string | null;
    facts_cursor_id: string | number | null; degraded_wakes: string | number | null;
  }>(READ_DELTA_SQL, keyParams(key));
  if (!r) return null;
  return {
    surfaced_slugs: r.surfaced_slugs,
    last_wake_at: r.last_wake_at ?? null,
    facts_cursor_at: r.facts_cursor_at ?? null,
    facts_cursor_id: r.facts_cursor_id == null ? null : Number(r.facts_cursor_id),
    degraded_wakes: Number(r.degraded_wakes ?? 0),
  };
}

/** The session's checkpoint manifest as the driver reads the jsonb; null when there is no row. */
export async function readCheckpointManifest(exec: LegacyUnscopedRead, key: SessionStateKey): Promise<{ checkpoint_manifest: unknown } | null> {
  const [r] = await exec.executeRaw<{ checkpoint_manifest: unknown }>(READ_MANIFEST_SQL, keyParams(key));
  return r ? { checkpoint_manifest: r.checkpoint_manifest } : null;
}

/** Upserts the session cursor in one statement (SessionContextWrite); returns the stored incomplete-wake counter. */
export async function upsertSessionContextRow(exec: SqlExecutor, key: SessionStateKey, w: SessionContextWrite): Promise<number> {
  const rows = await exec.executeRaw<{ degraded_wakes: string | number }>(UPSERT_STATE_SQL, [
    ...keyParams(key),
    JSON.stringify(w.standingEntities ?? []),
    JSON.stringify(w.cursorSlug === null ? [] : [w.cursorSlug]),
    w.lastWakeAt,
    w.standingEntities !== null,
    w.cursorSlug !== null,
    w.factsCursorAt,
    w.factsCursorId,
    w.degradedWakes,
  ]);
  return Number(rows[0]?.degraded_wakes ?? 0);
}

/** Replaces the session's checkpoint manifest, creating the row when there is none. */
export async function writeCheckpointManifest(exec: SqlExecutor, key: SessionStateKey, manifest: readonly unknown[]): Promise<void> {
  await exec.executeRaw(WRITE_MANIFEST_SQL, [...keyParams(key), JSON.stringify(manifest)]);
}

/**
 * Deletes the session rows not updated in `olderThanDays` days (a fraction is a part of a day), then the oldest rows
 * past `maxRowsPerClient` per `(source_id, client_id)`. The caller clamps both.
 */
export async function gcSessionContextRows(exec: SqlExecutor, olderThanDays: number, maxRowsPerClient: number): Promise<void> {
  await exec.executeRaw(GC_AGE_SQL, [String(olderThanDays)]);
  await exec.executeRaw(GC_CAP_SQL, [String(maxRowsPerClient)]);
}
