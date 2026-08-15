/**
 * v0.45.7 ambient recall (issue #1) — per-session cursor + boundary-tie dedup
 * for the `delta` verb and the heartbeat runtime.
 *
 * Parity-free by construction: both engines run the SAME `engine.executeRaw`
 * SQL (no per-engine method, so there is no parity surface to drift). jsonb
 * columns are written through the sanctioned `$N::text::jsonb` positional path
 * (binds as text, the cast parses it — dodges the postgres.js ::jsonb
 * double-encode trap; guarded by scripts/check-jsonb-params.mjs). The table is
 * `session_context_state` (migration v126); its schema parity is covered by the
 * schema-drift e2e.
 *
 * Key is (source_id, client_id, session_id). `client_id` is the caller's OAuth
 * client id for remote callers, or the 'local' sentinel for the trusted CLI/hook
 * path — so two remote harnesses in one source can never stomp/read each other's
 * cursor (eng 1B). All reads/writes are FAIL-OPEN: state is an optimization, and
 * a failure here must never block the recall read path.
 */

import type { BrainEngine } from '../engine.ts';

export const LOCAL_CLIENT_SENTINEL = 'local';

/** Cap on untrusted opaque ids used as PK components. */
const ID_MAX_LEN = 200;
/** Cap on a boundary-slug batch (defense in depth — the natural bound is the
 * delta fetch limit, since boundary slugs are ties at ONE timestamp and the
 * set is REPLACED on every cursor advance, never accumulated). */
const SURFACED_SLUGS_CAP = 500;

export interface SessionContextState {
  standing_entities: string[];
  /** Keyset slug component: `[cursorSlug]` (or `[]`). Column name is historical. */
  surfaced_slugs: string[];
  last_wake_at: string | null;
}

export interface SessionContextPatch {
  /** Replace the standing-entity set (omit to leave unchanged). */
  standingEntities?: string[];
  /**
   * The wake cursor's TIMESTAMP component (ISO; omit to leave unchanged). Paired
   * with `cursorSlug` this forms the keyset `(updatedAt, slug)` the `delta`
   * verb resumes from. Last-writer-wins (no monotonic guard): a keyset is a
   * two-part cursor, so a raw-timestamp GREATEST can't express its ordering;
   * an out-of-order write only risks bounded RE-delivery (cursor-dedup
   * tolerates it), never loss.
   */
  lastWakeAt?: string;
  /**
   * REPLACE the keyset slug — the slug of the last DELIVERED page at
   * `lastWakeAt` (omit to leave unchanged; `''` = start of the timestamp
   * bucket). Stored in the surfaced_slugs jsonb column (single-element).
   */
  cursorSlug?: string;
}

/** 'local' sentinel for the trusted CLI/hook path; the auth client id otherwise. */
export function resolveClientId(clientId?: string | null): string {
  return typeof clientId === 'string' && clientId.trim()
    ? clientId.trim().slice(0, ID_MAX_LEN)
    : LOCAL_CLIENT_SENTINEL;
}

function normSession(sessionId: string): string {
  return String(sessionId).slice(0, ID_MAX_LEN);
}

/** Normalize a DB timestamp text to ISO 8601 so downstream cursor comparisons
 * are format-stable (PGLite's ::text cast returns local-tz text, not ISO). */
function toIso(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : v;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Read the session cursor. Returns null when absent or on any error (fail-open). */
export async function getSessionContextState(
  engine: BrainEngine,
  sourceId: string,
  clientId: string | null | undefined,
  sessionId: string,
): Promise<SessionContextState | null> {
  try {
    const rows = await engine.executeRaw<{
      standing_entities: unknown;
      surfaced_slugs: unknown;
      last_wake_at: string | null;
    }>(
      `SELECT standing_entities, surfaced_slugs, last_wake_at::text AS last_wake_at
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`,
      [sourceId, resolveClientId(clientId), normSession(sessionId)],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      standing_entities: toStringArray(r.standing_entities),
      surfaced_slugs: toStringArray(r.surfaced_slugs),
      last_wake_at: toIso(r.last_wake_at ?? null),
    };
  } catch {
    return null;
  }
}

/**
 * Upsert the session cursor. SINGLE-STATEMENT atomic (adversarial review):
 * keep-if-absent and monotonic-cursor semantics run inside the UPDATE itself,
 * so concurrent pack/delta writers can't wipe banked entities or rewind the
 * cursor (the old read-modify-write raced). One round-trip — this call sits
 * inside the IPC push budget. jsonb via `$N::text::jsonb`. Fail-open.
 *
 * Param semantics in SQL:
 *   $4  standing_entities (jsonb) — applied only when $7 (replace flag) true
 *   $5  boundarySlugs (jsonb)     — REPLACES the set only when $8 true
 *   $6  lastWakeAt or null        — GREATEST with the stored cursor (monotonic;
 *                                   null keeps it)
 */
export async function upsertSessionContextState(
  engine: BrainEngine,
  sourceId: string,
  clientId: string | null | undefined,
  sessionId: string,
  patch: SessionContextPatch,
): Promise<void> {
  try {
    const replaceStanding = Array.isArray(patch.standingEntities);
    const replaceCursorSlug = typeof patch.cursorSlug === 'string';
    await engine.executeRaw(
      `INSERT INTO session_context_state
         (source_id, client_id, session_id, standing_entities, surfaced_slugs, last_wake_at, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb, $6, now())
       ON CONFLICT (source_id, client_id, session_id) DO UPDATE SET
         standing_entities = CASE WHEN $7::boolean THEN EXCLUDED.standing_entities
                                  ELSE session_context_state.standing_entities END,
         surfaced_slugs    = CASE WHEN $8::boolean THEN EXCLUDED.surfaced_slugs
                                  ELSE session_context_state.surfaced_slugs END,
         last_wake_at      = COALESCE(EXCLUDED.last_wake_at, session_context_state.last_wake_at),
         updated_at        = now()`,
      [
        sourceId,
        resolveClientId(clientId),
        normSession(sessionId),
        JSON.stringify(patch.standingEntities ?? []),
        JSON.stringify(typeof patch.cursorSlug === 'string' ? [patch.cursorSlug.slice(0, ID_MAX_LEN)] : []),
        patch.lastWakeAt ?? null,
        replaceStanding,
        replaceCursorSlug,
      ],
    );
  } catch {
    /* fail-open: a state-write failure must never block the recall read path */
  }
}

/** Max session rows retained per (source_id, client_id) — bounds a remote
 * caller minting session ids (red-team F3: authed ≠ trusted; a read token
 * could otherwise create unbounded rows inside the 7-day age window). */
export const MAX_ROWS_PER_CLIENT = 1000;

/**
 * Age out stale session rows (default 7 days) AND evict the oldest rows past
 * `maxRowsPerClient` (default MAX_ROWS_PER_CLIENT) per (source_id, client_id).
 * The cap is injectable (v0.45.7) so tests drive the REAL windowed DELETE with
 * a small cap instead of mirroring the SQL. Best-effort — runs at serve boot
 * and opportunistically on first-wake row creation.
 */
export async function gcSessionContextState(
  engine: BrainEngine,
  olderThanDays = 7,
  maxRowsPerClient = MAX_ROWS_PER_CLIENT,
): Promise<void> {
  try {
    await engine.executeRaw(
      `DELETE FROM session_context_state WHERE updated_at < now() - ($1 || ' days')::interval`,
      [String(Math.max(1, Math.floor(olderThanDays)))],
    );
    // Per-client LRU cap: keep the newest `maxRowsPerClient` rows per lane.
    await engine.executeRaw(
      `DELETE FROM session_context_state s
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
         AND ranked.rn > $1`,
      [String(Math.max(1, Math.floor(maxRowsPerClient)))],
    );
  } catch {
    /* best-effort */
  }
}
