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
