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
  /** delta's facts keyset `(created_at, id)` at column precision (omit to leave unchanged). */
  factsCursor?: { at: string; id: number | null };
  /** `increment` adds one atomically (returned); `reset` sets 0 (omit to leave unchanged). */
  degradedWakes?: 'increment' | 'reset';
}

/** delta's view of a session row: both arm cursors plus the incomplete-wake counter. */
export interface DeltaSessionState {
  last_wake_at: string | null;
  cursor_slug: string | undefined;
  facts_cursor_at: string | null;
  facts_cursor_id: number | null;
  degraded_wakes: number;
}

/**
 * delta reads distinguish ABSENT (no row: a first wake) from UNAVAILABLE (the
 * read failed). Treating a failed read as absence would re-initialize the
 * session at now and silently drop everything since its checkpoint.
 */
export type DeltaSessionRead =
  | { status: 'absent' }
  | { status: 'loaded'; state: DeltaSessionState }
  | { status: 'unavailable'; error: string };

/** 'local' sentinel for the trusted CLI/hook path; the auth client id otherwise. */
export function resolveClientId(clientId?: string | null): string {
  return typeof clientId === 'string' && clientId.trim()
    ? clientId.trim().slice(0, ID_MAX_LEN)
    : LOCAL_CLIENT_SENTINEL;
}

function normSession(sessionId: string): string {
  return String(sessionId).slice(0, ID_MAX_LEN);
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
      // ISO UTC at the column's microsecond precision (not ::text — PGLite
      // renders local-tz text, and a JS Date round-trip would re-round the
      // keyset cursor to milliseconds, re-delivering same-millisecond pages).
      `SELECT standing_entities, surfaced_slugs,
              to_char(last_wake_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_wake_at
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`,
      [sourceId, resolveClientId(clientId), normSession(sessionId)],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      standing_entities: toStringArray(r.standing_entities),
      surfaced_slugs: toStringArray(r.surfaced_slugs),
      last_wake_at: r.last_wake_at ?? null,
    };
  } catch {
    return null;
  }
}

const ISO_US = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function readDeltaSessionState(
  engine: BrainEngine,
  sourceId: string,
  clientId: string | null | undefined,
  sessionId: string,
): Promise<DeltaSessionRead> {
  try {
    const rows = await engine.executeRaw<{
      surfaced_slugs: unknown;
      last_wake_at: string | null;
      facts_cursor_at: string | null;
      facts_cursor_id: string | number | null;
      degraded_wakes: string | number | null;
    }>(
      `SELECT surfaced_slugs, ${ISO_US('last_wake_at')} AS last_wake_at,
              ${ISO_US('facts_cursor_at')} AS facts_cursor_at, facts_cursor_id, degraded_wakes
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`,
      [sourceId, resolveClientId(clientId), normSession(sessionId)],
    );
    if (!rows.length) return { status: 'absent' };
    const r = rows[0];
    return {
      status: 'loaded',
      state: {
        last_wake_at: r.last_wake_at ?? null,
        cursor_slug: toStringArray(r.surfaced_slugs)[0],
        facts_cursor_at: r.facts_cursor_at ?? null,
        facts_cursor_id: r.facts_cursor_id == null ? null : Number(r.facts_cursor_id),
        degraded_wakes: Number(r.degraded_wakes ?? 0),
      },
    };
  } catch (e) {
    return { status: 'unavailable', error: e instanceof Error ? e.message : String(e) };
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
): Promise<{ ok: true; degradedWakes: number } | { ok: false; error: string }> {
  try {
    const replaceStanding = Array.isArray(patch.standingEntities);
    const replaceCursorSlug = typeof patch.cursorSlug === 'string';
    const rows = await engine.executeRaw<{ degraded_wakes: string | number }>(
      `INSERT INTO session_context_state
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
       RETURNING degraded_wakes`,
      [
        sourceId,
        resolveClientId(clientId),
        normSession(sessionId),
        JSON.stringify(patch.standingEntities ?? []),
        JSON.stringify(typeof patch.cursorSlug === 'string' ? [patch.cursorSlug.slice(0, ID_MAX_LEN)] : []),
        patch.lastWakeAt ?? null,
        replaceStanding,
        replaceCursorSlug,
        patch.factsCursor?.at ?? null,
        patch.factsCursor ? patch.factsCursor.id : null,
        patch.degradedWakes ?? 'keep',
      ],
    );
    return { ok: true, degradedWakes: Number(rows[0]?.degraded_wakes ?? 0) };
  } catch (e) {
    /* fail-open: a state-write failure never blocks the read path; delta surfaces it as `session_state` */
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One brain-link banked by the compaction-boundary harvest (Cathedral 5).
 * `seg` is the content hash of the harvested corpus segment — the completion
 * key the OpenClaw assemble poll matches on (a stale non-empty manifest can't
 * satisfy a poll for a specific checkpoint). `n` is the ledger ordinal of the
 * checkpoint that banked the link (metadata only, never a filename component).
 */
export interface CheckpointLink {
  slug: string;
  title: string;
  /** ISO timestamp the link was banked. */
  at: string;
  n: number;
  seg: string;
}

/** Manifest cap: newest-first, dedup-by-slug on append. */
export const CHECKPOINT_MANIFEST_CAP = 20;

function toCheckpointLinks(v: unknown): CheckpointLink[] {
  let arr: unknown = v;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (x): x is CheckpointLink =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as CheckpointLink).slug === 'string' &&
      typeof (x as CheckpointLink).title === 'string' &&
      typeof (x as CheckpointLink).at === 'string' &&
      typeof (x as CheckpointLink).n === 'number' &&
      typeof (x as CheckpointLink).seg === 'string',
  );
}

/**
 * Read the session's checkpoint manifest. Distinguishes a CONFIRMED answer
 * from a failed read (adversarial review): `[]` means the row/manifest is
 * genuinely absent or empty; `null` means the read errored (engine down,
 * pre-v132 schema). Callers on the render path treat null as [] (fail-open);
 * `appendCheckpointManifest` treats null as abort (a merge seeded from a
 * failed read would overwrite-truncate the standing manifest), and the
 * assemble poll only SETTLES on a confirmed answer.
 */
export async function getCheckpointManifest(
  engine: BrainEngine,
  sourceId: string,
  clientId: string | null | undefined,
  sessionId: string,
): Promise<CheckpointLink[] | null> {
  try {
    const rows = await engine.executeRaw<{ checkpoint_manifest: unknown }>(
      `SELECT checkpoint_manifest
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`,
      [sourceId, resolveClientId(clientId), normSession(sessionId)],
    );
    if (!rows.length) return [];
    return toCheckpointLinks(rows[0].checkpoint_manifest);
  } catch {
    return null;
  }
}

/**
 * Append checkpoint links to the manifest: newest-first, dedup-by-slug (an
 * existing slug's entry is refreshed and moved to the front), capped at
 * CHECKPOINT_MANIFEST_CAP. Read-modify-write is safe in practice — the serve
 * harvest FIFO is single-in-flight and the OpenClaw rung-3 writer only runs
 * when serve is unreachable; a benign race loses at most one append (the
 * manifest is an optimization like the rest of this table). jsonb binds via
 * `$N::text::jsonb`.
 *
 * Returns true only on a CONFIRMED publish (adversarial review): a failed
 * READ aborts without writing — merging into `[]` from a transient read error
 * would overwrite-truncate up to CAP−1 standing links — and a failed write
 * returns false so the harvest keeps its receipt (and skips `.ingested`)
 * instead of deleting the only durable copy of the links. Never throws.
 */
export async function appendCheckpointManifest(
  engine: BrainEngine,
  sourceId: string,
  clientId: string | null | undefined,
  sessionId: string,
  links: Array<{ slug: string; title: string }>,
  meta: { seg: string; n: number; at?: string },
): Promise<boolean> {
  if (!links.length) return true;
  try {
    const existing = await getCheckpointManifest(engine, sourceId, clientId, sessionId);
    if (existing === null) return false;
    const at = meta.at ?? new Date().toISOString();
    const fresh: CheckpointLink[] = links.map((l) => ({
      slug: l.slug.slice(0, ID_MAX_LEN),
      // Collapse whitespace: titles render as single lines in the pack /
      // assemble block — an embedded newline from ingested content must not
      // inject extra lines into model context.
      title: l.title.replace(/\s+/g, ' ').trim().slice(0, 300),
      at,
      n: meta.n,
      seg: meta.seg.slice(0, ID_MAX_LEN),
    }));
    const freshSlugs = new Set(fresh.map((l) => l.slug));
    const merged = [...fresh, ...existing.filter((l) => !freshSlugs.has(l.slug))].slice(
      0,
      CHECKPOINT_MANIFEST_CAP,
    );
    await engine.executeRaw(
      `INSERT INTO session_context_state
         (source_id, client_id, session_id, checkpoint_manifest, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, now())
       ON CONFLICT (source_id, client_id, session_id) DO UPDATE SET
         checkpoint_manifest = EXCLUDED.checkpoint_manifest,
         updated_at          = now()`,
      [sourceId, resolveClientId(clientId), normSession(sessionId), JSON.stringify(merged)],
    );
    return true;
  } catch {
    /* fail-open: a manifest-write failure must never THROW into the harvest */
    return false;
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
