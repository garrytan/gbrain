/**
 * Open loops (`open_loops`, src/schema.sql): the upsert, list and close statements loops-store.ts ran through
 * `executeRaw`, with the same text and parameters, on the engine's own raw path; only their home moved. The members
 * return the raw rows; loops-store.ts still normalizes them. The other loop statements (thread auto-close, the
 * staleness pass, mutes, the loop-fact reads) stay with their callers.
 *
 * `'mute_recheck'` and `'muted'` are `MUTE_RECHECK` and `MUTED` in loops-store.ts, written here as literals so this
 * module needs no runtime import of the store.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { ListLoopsOpts, LoopStatus, OpenLoopUpsert } from '../loops/loops-store.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { rows } from './search-reads.ts';

/** What `upsertOpenLoop` resolves: the row id, whether the row is new, and whether the write landed. */
export interface OpenLoopUpsertResult { id: number; created: boolean; applied: boolean }

/** An `open_loops` row as the engine returns it (times are Dates, ids may be strings on Postgres). */
export type OpenLoopDbRow = Record<string, unknown>;

export async function upsertOpenLoop(exec: SqlExecutor, loop: OpenLoopUpsert): Promise<OpenLoopUpsertResult> {
  const rows = await exec.executeRaw<{ id: number; created: boolean }>(
    `INSERT INTO open_loops (
       source_id, dedup_key, loop_type, counterparty_slug, counterparty_email,
       summary, evidence, thread_id, page_slug, due_at, detector, confidence,
       fact_id, last_activity_at, opened_at, counterparty_source_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10::timestamptz, $11, $12,
       $13, COALESCE($14::timestamptz, now()), COALESCE($15::timestamptz, now()), $16
     )
     ON CONFLICT (source_id, dedup_key) DO UPDATE SET
       opened_at = CASE WHEN open_loops.status = 'open'
                        THEN LEAST(open_loops.opened_at, EXCLUDED.opened_at)
                        ELSE EXCLUDED.opened_at END,
       status = 'open',
       loop_type = EXCLUDED.loop_type,
       counterparty_slug = COALESCE(EXCLUDED.counterparty_slug, open_loops.counterparty_slug),
       counterparty_source_id = CASE WHEN EXCLUDED.counterparty_slug IS NULL
                                     THEN open_loops.counterparty_source_id
                                     ELSE EXCLUDED.counterparty_source_id END,
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
     WHERE (open_loops.status = 'open'
            OR EXCLUDED.last_activity_at > open_loops.last_activity_at
            OR open_loops.closed_by = 'mute_recheck')
       AND (open_loops.closed_by IS DISTINCT FROM 'muted'
            OR open_loops.counterparty_email IS DISTINCT FROM EXCLUDED.counterparty_email)
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
      loop.openedAt ?? null,
      loop.counterpartySlug ? (loop.counterpartySourceId ?? null) : null,
    ],
  );
  // The DO UPDATE's WHERE is the manual-close guard: a closed (done/dropped/
  // stale) row only reopens on GENUINELY newer activity. Without it, any
  // re-render of an unchanged thread (label-only history touch, re-extraction
  // of the same content) would silently revert `gbrain loops done`. #5012: a
  // loop a mute closed never reopens for the same counterparty while muted,
  // and one an unmute queued for re-check reopens on the re-check's verdict.
  if (rows.length > 0) {
    return { id: Number(rows[0].id), created: Boolean(rows[0].created), applied: true };
  }
  const existing = await exec.executeRaw<{ id: number }>(
    `SELECT id FROM open_loops WHERE source_id = $1 AND dedup_key = $2`,
    [loop.sourceId, loop.dedupKey],
  );
  return { id: Number(existing[0]?.id ?? 0), created: false, applied: false };
}

export async function closeOpenLoop(
  exec: SqlExecutor,
  sourceId: string | null,
  id: number,
  status: Exclude<LoopStatus, 'open'>,
  closedBy: string,
): Promise<OpenLoopDbRow | null> {
  const rows = await exec.executeRaw<OpenLoopDbRow>(
    `UPDATE open_loops
       SET status = $1, closed_at = now(), closed_by = $2, updated_at = now()
     WHERE id = $3 AND status = 'open' AND ($4::text IS NULL OR source_id = $4)
     RETURNING *`,
    [status, closedBy, id, sourceId],
  );
  return rows[0] ?? null;
}

/** An open loop on an entity card, as `readEntityOpenLoops` returns it (times are Dates on the SQL engines). */
export interface EntityOpenLoopRow {
  id: number;
  loop_type: string;
  summary: string;
  due_at: Date | string | null;
  last_activity_at: Date | string;
  fact_id: number | null;
}

/**
 * entity-card.ts assembleCard's open-loop read: the open loops whose counterparty page is (sourceId, slug), a row with
 * no counterparty source counting as its own source's, newest activity first and then the newest loop id, at most
 * `limit`. The caller's text and parameters, plus the `id DESC` tie-break; `limit` is the integer literal it
 * interpolated.
 */
export async function readEntityOpenLoops(exec: LegacyUnscopedRead, slug: string, sourceId: string, limit: number): Promise<EntityOpenLoopRow[]> {
  if (!Number.isFinite(limit) || !Number.isSafeInteger(limit) || limit < 1) throw new Error(`readEntityOpenLoops: limit must be a positive integer, got ${limit}`);
  return rows<EntityOpenLoopRow>(exec, sqlFragment`SELECT id, loop_type, summary, due_at, last_activity_at, fact_id
       FROM open_loops
       WHERE status = 'open' AND counterparty_slug = ${slug}
         AND COALESCE(counterparty_source_id, source_id) = ${sourceId}
       ORDER BY last_activity_at DESC, id DESC
       LIMIT ${trustedSql(`${limit}`)}`);
}

export async function listOpenLoops(exec: LegacyUnscopedRead, opts: ListLoopsOpts = {}): Promise<OpenLoopDbRow[]> {
  // The clamped limit binds as `$7`; a fraction rounds as the `LIMIT ${n}` literal it replaces did.
  const limit = Math.round(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  return exec.executeRaw<OpenLoopDbRow>(
    `SELECT * FROM open_loops
     WHERE ($1::text IS NULL OR source_id = ANY(string_to_array($1, ',')))
       AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR loop_type = $3)
       AND ($4::text IS NULL
            OR (counterparty_slug = $4 AND ($6::text IS NULL OR COALESCE(counterparty_source_id, source_id) = $6))
            OR counterparty_email = $4)
       AND ($5::bigint IS NULL OR id = $5::bigint)
     ORDER BY last_activity_at DESC, id DESC
     LIMIT $7`,
    [
      opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds.join(',') : null,
      opts.status ?? null,
      opts.loopType ?? null,
      opts.counterparty ?? null,
      opts.loopId === undefined ? null : opts.loopId,
      opts.counterpartySourceId ?? null,
      limit,
    ],
  );
}

/** One sender's open loop count, as `countOpenLoopsByCounterpartyEmail` returns it. */
export interface CounterpartyEmailLoopCount { email: string; n: number }

/**
 * The open loops of `loopType` in `sourceId` per counterparty email among `emails`, one row per email with any, in no
 * set order (the withheld-noise card of `open_loops`, ops/loops.ts). No limit: every loop counts.
 */
export async function countOpenLoopsByCounterpartyEmail(exec: LegacyUnscopedRead, sourceId: string, emails: readonly string[], loopType: string): Promise<CounterpartyEmailLoopCount[]> {
  if (emails.length === 0) return [];
  const found = await exec.executeRaw<{ email: string; n: number | string }>(
    `SELECT counterparty_email AS email, count(*)::int AS n FROM open_loops
      WHERE source_id = $1 AND status = 'open' AND loop_type = $3
        AND counterparty_email = ANY(string_to_array($2, E'\n'))
      GROUP BY counterparty_email`, [sourceId, emails.join('\n'), loopType]);
  return found.map(r => ({ email: r.email, n: Number(r.n) }));
}
