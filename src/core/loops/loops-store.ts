/**
 * loops-store — SQL accessors for the open_loops + loop_suppressions tables.
 *
 * One shared module over engine.executeRaw with IDENTICAL SQL text on both
 * engines — parity by construction (the pattern sources-ops.ts uses), no
 * per-engine method twins to keep in lockstep.
 *
 * JSONB discipline: evidence binds through `$N::text::jsonb` (the sanctioned
 * positional pattern) — never a bare `::jsonb` cast over JSON.stringify.
 *
 * Loops CLOSE by state transition, never delete: reply-driven auto-close
 * flips status to 'done' and stamps closed_by, keeping the audit trail.
 */

import type { BrainEngine } from '../engine.ts';

export type LoopType =
  | 'commitment_owed_by_me'
  | 'commitment_owed_to_me'
  | 'unanswered_inbound'
  | 'unanswered_outbound'
  | 'decision_pending';

export type LoopStatus = 'open' | 'done' | 'dropped' | 'stale';
export type LoopDetector = 'deterministic_thread' | 'llm_extract' | 'manual';

export interface LoopEvidence {
  message_id?: string;
  page_slug?: string;
  quote?: string;
}

export interface OpenLoopUpsert {
  sourceId: string;
  dedupKey: string;
  loopType: LoopType;
  counterpartySlug?: string | null;
  counterpartyEmail?: string | null;
  summary: string;
  evidence: LoopEvidence[];
  threadId?: string | null;
  pageSlug?: string | null;
  dueAt?: string | null;
  detector: LoopDetector;
  confidence?: number;
  factId?: number | null;
  /** Loop activity time (newest evidence message), ISO. Defaults to now(). */
  lastActivityAt?: string | null;
}

export interface OpenLoopRow {
  id: number;
  source_id: string;
  dedup_key: string;
  loop_type: LoopType;
  counterparty_slug: string | null;
  counterparty_email: string | null;
  summary: string;
  evidence: LoopEvidence[];
  thread_id: string | null;
  page_slug: string | null;
  due_at: string | null;
  status: LoopStatus;
  detector: LoopDetector;
  confidence: number;
  fact_id: number | null;
  opened_at: string;
  last_activity_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

/** Engines return timestamptz as a JS Date (PGLite, postgres.js default) —
 *  normalize to the ISO strings OpenLoopRow declares, or every downstream
 *  `.slice(0, 10)` on due_at/last_activity_at crashes at runtime. */
function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return String(v);
}

function normalizeRow(r: Record<string, unknown>): OpenLoopRow {
  const ev = r.evidence;
  return {
    ...(r as unknown as OpenLoopRow),
    // postgres.js returns BIGSERIAL/BIGINT as STRINGS ("1") while PGLite
    // returns numbers — without coercion, id equality (`loops show <id>`,
    // close-by-id checks) silently fails on real Postgres only.
    id: Number(r.id),
    fact_id: r.fact_id === null || r.fact_id === undefined ? null : Number(r.fact_id),
    confidence: Number(r.confidence ?? 1),
    evidence:
      typeof ev === 'string'
        ? (JSON.parse(ev) as LoopEvidence[])
        : Array.isArray(ev)
          ? (ev as LoopEvidence[])
          : [],
    due_at: toIsoOrNull(r.due_at),
    opened_at: toIsoOrNull(r.opened_at) ?? new Date(0).toISOString(),
    last_activity_at: toIsoOrNull(r.last_activity_at) ?? new Date(0).toISOString(),
    closed_at: toIsoOrNull(r.closed_at),
  };
}

export async function upsertOpenLoop(
  engine: BrainEngine,
  loop: OpenLoopUpsert,
): Promise<{ id: number; created: boolean; applied: boolean }> {
  const rows = await engine.executeRaw<{ id: number; created: boolean }>(
    `INSERT INTO open_loops (
       source_id, dedup_key, loop_type, counterparty_slug, counterparty_email,
       summary, evidence, thread_id, page_slug, due_at, detector, confidence,
       fact_id, last_activity_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10::timestamptz, $11, $12,
       $13, COALESCE($14::timestamptz, now())
     )
     ON CONFLICT (source_id, dedup_key) DO UPDATE SET
       status = 'open',
       loop_type = EXCLUDED.loop_type,
       counterparty_slug = COALESCE(EXCLUDED.counterparty_slug, open_loops.counterparty_slug),
       counterparty_email = COALESCE(EXCLUDED.counterparty_email, open_loops.counterparty_email),
       summary = EXCLUDED.summary,
       evidence = EXCLUDED.evidence,
       page_slug = COALESCE(EXCLUDED.page_slug, open_loops.page_slug),
       due_at = COALESCE(EXCLUDED.due_at, open_loops.due_at),
       confidence = EXCLUDED.confidence,
       fact_id = COALESCE(EXCLUDED.fact_id, open_loops.fact_id),
       last_activity_at = GREATEST(open_loops.last_activity_at, EXCLUDED.last_activity_at),
       closed_at = NULL,
       closed_by = NULL,
       updated_at = now()
     WHERE open_loops.status = 'open'
        OR EXCLUDED.last_activity_at > open_loops.last_activity_at
     RETURNING id, (xmax = 0) AS created`,
    [
      loop.sourceId,
      loop.dedupKey,
      loop.loopType,
      loop.counterpartySlug ?? null,
      loop.counterpartyEmail ?? null,
      loop.summary,
      JSON.stringify(loop.evidence),
      loop.threadId ?? null,
      loop.pageSlug ?? null,
      loop.dueAt ?? null,
      loop.detector,
      loop.confidence ?? 1.0,
      loop.factId ?? null,
      loop.lastActivityAt ?? null,
    ],
  );
  // The DO UPDATE's WHERE is the manual-close guard: a closed (done/dropped/
  // stale) row only reopens on GENUINELY newer activity. Without it, any
  // re-render of an unchanged thread (label-only history touch, re-extraction
  // of the same content) would silently revert `gbrain loops done`.
  if (rows.length > 0) {
    return { id: Number(rows[0].id), created: Boolean(rows[0].created), applied: true };
  }
  const existing = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM open_loops WHERE source_id = $1 AND dedup_key = $2`,
    [loop.sourceId, loop.dedupKey],
  );
  return { id: Number(existing[0]?.id ?? 0), created: false, applied: false };
}

/** Close one loop by id (scoped to its source). Returns the row, or null. */
export async function closeOpenLoop(
  engine: BrainEngine,
  sourceId: string | null,
  id: number,
  status: Exclude<LoopStatus, 'open'>,
  closedBy: string,
): Promise<OpenLoopRow | null> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `UPDATE open_loops
       SET status = $1, closed_at = now(), closed_by = $2, updated_at = now()
     WHERE id = $3 AND status = 'open' AND ($4::text IS NULL OR source_id = $4)
     RETURNING *`,
    [status, closedBy, id, sourceId],
  );
  return rows.length > 0 ? normalizeRow(rows[0]) : null;
}

/** Close every open thread-detector loop for a thread (reply auto-close). */
export async function closeThreadLoops(
  engine: BrainEngine,
  sourceId: string,
  threadId: string,
  closedBy: string,
  only?: LoopType[],
): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE open_loops
       SET status = 'done', closed_at = now(), closed_by = $1, updated_at = now()
     WHERE source_id = $2 AND thread_id = $3 AND status = 'open'
       AND detector = 'deterministic_thread'
       AND ($4::text IS NULL OR loop_type = ANY(string_to_array($4, ',')))
     RETURNING id`,
    [closedBy, sourceId, threadId, only && only.length > 0 ? only.join(',') : null],
  );
  return rows.length;
}

export interface ListLoopsOpts {
  sourceIds?: string[];
  status?: LoopStatus;
  loopType?: LoopType;
  counterparty?: string;
  limit?: number;
}

export async function listOpenLoops(
  engine: BrainEngine,
  opts: ListLoopsOpts = {},
): Promise<OpenLoopRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM open_loops
     WHERE ($1::text IS NULL OR source_id = ANY(string_to_array($1, ',')))
       AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR loop_type = $3)
       AND ($4::text IS NULL OR counterparty_slug = $4 OR counterparty_email = $4)
     ORDER BY last_activity_at DESC, id DESC
     LIMIT ${limit}`,
    [
      opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds.join(',') : null,
      opts.status ?? null,
      opts.loopType ?? null,
      opts.counterparty ?? null,
    ],
  );
  return rows.map(normalizeRow);
}

/**
 * Staleness pass (v1 close semantics for commitment loops): overdue by >14d,
 * or >90 days without activity — aligned with HALFLIFE_DAYS.commitment.
 */
export async function markStaleLoops(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE open_loops
       SET status = 'stale', closed_at = now(), closed_by = 'staleness', updated_at = now()
     WHERE source_id = $1 AND status = 'open' AND detector = 'llm_extract'
       AND (
         -- Overdue alone isn't stale: an actively-discussed commitment
         -- (fresh last_activity_at) must not ping-pong stale->open->stale
         -- against the upsert's reopen on every sweep.
         (due_at IS NOT NULL AND due_at < now() - interval '14 days'
            AND last_activity_at < now() - interval '14 days')
         OR last_activity_at < now() - interval '90 days'
       )
     RETURNING id`,
    [sourceId],
  );
  return rows.length;
}

// ── Suppressions (`gbrain loops mute`) ───────────────────────────────────────

export async function addSuppression(
  engine: BrainEngine,
  sourceId: string,
  kind: 'sender' | 'thread',
  value: string,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO loop_suppressions (source_id, kind, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (source_id, kind, value) DO NOTHING`,
    [sourceId, kind, value.toLowerCase()],
  );
}

/**
 * Remove one exact suppression row (`gbrain loops unmute`).
 *
 * The symmetric counterpart to addSuppression, and deliberately narrow: it
 * matches the SAME (source_id, kind, value) triple the insert wrote, with the
 * same lower-casing, so an unmute can never remove a sibling source's row or a
 * different kind. Returns the number of rows removed — 0 is the ordinary
 * "already not muted" answer, not an error, which keeps a repeated unmute
 * idempotent for callers that retry.
 *
 * Suppressions only gate NEW loop creation (see loop-detect), so removing one
 * changes future detection only; it never reopens or mutates existing loops.
 */
export async function removeSuppression(
  engine: BrainEngine,
  sourceId: string,
  kind: 'sender' | 'thread',
  value: string,
): Promise<number> {
  const rows = await engine.executeRaw<{ value: string }>(
    `DELETE FROM loop_suppressions
      WHERE source_id = $1 AND kind = $2 AND value = $3
      RETURNING value`,
    [sourceId, kind, value.toLowerCase()],
  );
  return rows.length;
}

export interface SuppressionSet {
  senders: Set<string>;
  threads: Set<string>;
}

export async function loadSuppressions(
  engine: BrainEngine,
  sourceId: string,
): Promise<SuppressionSet> {
  const rows = await engine.executeRaw<{ kind: string; value: string }>(
    `SELECT kind, value FROM loop_suppressions WHERE source_id = $1`,
    [sourceId],
  );
  const senders = new Set<string>();
  const threads = new Set<string>();
  for (const r of rows) {
    if (r.kind === 'sender') senders.add(r.value);
    else threads.add(r.value);
  }
  return { senders, threads };
}
