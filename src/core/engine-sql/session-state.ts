/**
 * Session state: the `session_context_state` statements that context/session-state.ts ran through `engine.executeRaw`
 * (the session cursor of context_pack and delta, the checkpoint manifest, and its garbage collection), once for both
 * engines. Each statement text is the caller's, byte for byte (pinned by test/engine-sql-caller-raw-sql-pins.test.ts),
 * and runs through the engine's own executeRaw, so a statement fault a test injects on the engine still reaches it.
 *
 * Every member takes the row key as the caller resolved it (client id and session id already capped). A failure
 * throws unchanged: the caller keeps the fail-open behaviour (context/session-state.ts).
 */

/** The engine's own executeRaw. */
export interface SessionStateExec {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** The row context_pack reads: standing entities and cursor slug as stored (jsonb), and the wake time. */
export interface SessionCursorRow {
  standing_entities: unknown;
  surfaced_slugs: unknown;
  /** ISO UTC text at the column's microsecond precision, or null. */
  last_wake_at: string | null;
}

/**
 * ISO UTC at the column's microsecond precision (not ::text — PGLite renders local-tz text, and a JS Date round-trip
 * would re-round the keyset cursor to milliseconds, re-delivering same-millisecond pages).
 */
export const SESSION_CURSOR_SQL = `SELECT standing_entities, surfaced_slugs,
              to_char(last_wake_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_wake_at
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`;

/** The session cursor row, or null when the session has none. */
export async function readSessionCursor(exec: SessionStateExec, sourceId: string, clientId: string, sessionId: string): Promise<SessionCursorRow | null> {
  const rows = await exec.executeRaw<SessionCursorRow>(SESSION_CURSOR_SQL, [sourceId, clientId, sessionId]);
  if (!rows.length) return null;
  const r = rows[0]!;
  return { standing_entities: r.standing_entities, surfaced_slugs: r.surfaced_slugs, last_wake_at: r.last_wake_at ?? null };
}

/** delta's view of a session row: the slug cursor as stored (jsonb), both arm cursors and the incomplete-wake counter. */
export interface DeltaSessionRow {
  surfaced_slugs: unknown;
  last_wake_at: string | null;
  facts_cursor_at: string | null;
  facts_cursor_id: number | null;
  degraded_wakes: number;
}

// Both times read back as microsecond ISO text (the ISO_US helper this read used in context/session-state.ts), spelled
// out so the statement stays one constant.
export const DELTA_SESSION_SQL = `SELECT surfaced_slugs, to_char(last_wake_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_wake_at,
              to_char(facts_cursor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS facts_cursor_at, facts_cursor_id, degraded_wakes
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`;

/** delta's session row, or null when the session has none. `bigint` and `integer` read back as numbers. */
export async function readDeltaSessionRow(exec: SessionStateExec, sourceId: string, clientId: string, sessionId: string): Promise<DeltaSessionRow | null> {
  const rows = await exec.executeRaw<{
    surfaced_slugs: unknown;
    last_wake_at: string | null;
    facts_cursor_at: string | null;
    facts_cursor_id: string | number | null;
    degraded_wakes: string | number | null;
  }>(DELTA_SESSION_SQL, [sourceId, clientId, sessionId]);
  if (!rows.length) return null;
  const r = rows[0]!;
  return {
    surfaced_slugs: r.surfaced_slugs,
    last_wake_at: r.last_wake_at ?? null,
    facts_cursor_at: r.facts_cursor_at ?? null,
    facts_cursor_id: r.facts_cursor_id == null ? null : Number(r.facts_cursor_id),
    degraded_wakes: Number(r.degraded_wakes ?? 0),
  };
}

/** One session cursor write. Each field mirrors a bound parameter of `UPSERT_SESSION_STATE_SQL`. */
export interface SessionStateWrite {
  /** Stored on insert; replaces the stored set only when `replaceStanding`. */
  standingEntities: unknown[];
  /** The keyset slug (`[cursorSlug]` or `[]`); replaces the stored one only when `replaceCursorSlug`. */
  surfacedSlugs: string[];
  /** The wake time (ISO), or null to keep the stored one. */
  lastWakeAt: string | null;
  replaceStanding: boolean;
  replaceCursorSlug: boolean;
  /** delta's facts keyset `(created_at, id)`; a null `factsCursorAt` keeps both stored parts. */
  factsCursorAt: string | null;
  factsCursorId: number | null;
  /** `increment` adds one, `reset` sets 0, `keep` leaves the counter. */
  degradedWakes: 'increment' | 'reset' | 'keep';
}

export const UPSERT_SESSION_STATE_SQL = `INSERT INTO session_context_state
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

/** Inserts or updates the session cursor in one statement and returns the row's incomplete-wake counter. */
export async function upsertSessionState(exec: SessionStateExec, sourceId: string, clientId: string, sessionId: string, write: SessionStateWrite): Promise<number> {
  const rows = await exec.executeRaw<{ degraded_wakes: string | number }>(UPSERT_SESSION_STATE_SQL, [
    sourceId,
    clientId,
    sessionId,
    JSON.stringify(write.standingEntities),
    JSON.stringify(write.surfacedSlugs),
    write.lastWakeAt,
    write.replaceStanding,
    write.replaceCursorSlug,
    write.factsCursorAt,
    write.factsCursorId,
    write.degradedWakes,
  ]);
  return Number(rows[0]?.degraded_wakes ?? 0);
}

export const CHECKPOINT_MANIFEST_SQL = `SELECT checkpoint_manifest
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`;

/** The session's checkpoint manifest as stored (jsonb), or null when the session has no row. */
export async function readCheckpointManifestRow(exec: SessionStateExec, sourceId: string, clientId: string, sessionId: string): Promise<{ checkpoint_manifest: unknown } | null> {
  const rows = await exec.executeRaw<{ checkpoint_manifest: unknown }>(CHECKPOINT_MANIFEST_SQL, [sourceId, clientId, sessionId]);
  return rows.length ? { checkpoint_manifest: rows[0]!.checkpoint_manifest } : null;
}

export const WRITE_CHECKPOINT_MANIFEST_SQL = `INSERT INTO session_context_state
         (source_id, client_id, session_id, checkpoint_manifest, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, now())
       ON CONFLICT (source_id, client_id, session_id) DO UPDATE SET
         checkpoint_manifest = EXCLUDED.checkpoint_manifest,
         updated_at          = now()`;

/** Replaces the session's checkpoint manifest, creating the row when there is none. */
export async function writeCheckpointManifest(exec: SessionStateExec, sourceId: string, clientId: string, sessionId: string, manifest: readonly unknown[]): Promise<void> {
  await exec.executeRaw(WRITE_CHECKPOINT_MANIFEST_SQL, [sourceId, clientId, sessionId, JSON.stringify(manifest)]);
}

export const AGE_OUT_SESSION_STATE_SQL = `DELETE FROM session_context_state WHERE updated_at < now() - ($1 || ' days')::interval`;

/** Deletes every session row last written more than `olderThanDays` days ago (the caller passes a whole number >= 1). */
export async function ageOutSessionState(exec: SessionStateExec, olderThanDays: number): Promise<void> {
  await exec.executeRaw(AGE_OUT_SESSION_STATE_SQL, [String(olderThanDays)]);
}

/** Per-client LRU cap: keep the newest `maxRowsPerClient` rows per lane; tied rows rank by session_id bytes. */
export const CAP_SESSION_STATE_SQL = `DELETE FROM session_context_state s
       USING (
         SELECT source_id, client_id, session_id,
                row_number() OVER (
                  PARTITION BY source_id, client_id ORDER BY updated_at DESC, session_id COLLATE "C"
                ) AS rn
         FROM session_context_state
       ) ranked
       WHERE s.source_id = ranked.source_id
         AND s.client_id = ranked.client_id
         AND s.session_id = ranked.session_id
         AND ranked.rn > $1`;

/**
 * Keeps the newest `maxRowsPerClient` rows of each (source_id, client_id) and deletes the rest (the caller passes a
 * whole number >= 1). Rows with equal `updated_at` (one transaction's writes) rank by `session_id` bytes, lowest
 * kept, so the kept rows never depend on heap order and every engine arm keeps the same rows.
 */
export async function capSessionStatePerClient(exec: SessionStateExec, maxRowsPerClient: number): Promise<void> {
  await exec.executeRaw(CAP_SESSION_STATE_SQL, [String(maxRowsPerClient)]);
}
