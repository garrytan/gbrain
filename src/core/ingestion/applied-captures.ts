/**
 * GST-1856: the applied-capture record (`ingest_applied_captures`, migration v296).
 *
 * An `ingest_capture` job whose write landed records it under the job's idempotency key, in the page write's own
 * transaction on an unmanaged brain and right after the door commits on a managed one. Any later run of the same key (a
 * stalled attempt re-run after its write landed, a POST /ingest replayed after `gbrain jobs prune` removed the job
 * row) returns the stored result and writes nothing, so it cannot revert a newer edit. Each capture has its own key, so
 * ordered captures to one slug all apply. A managed write's door request carries a client request_id under
 * `appliedCaptureRequestPrefix(key)`, so a committed request the handler sent as the local writer, found without its row
 * (the worker died between the commit and the insert), counts as applied and backfills the row; a remote writer's request
 * under the same prefix never counts. Rows live 90 days, at least as long as the job rows the
 * queue-level dedupe relied on (`gbrain jobs prune` defaults to 30 days).
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

export const APPLIED_CAPTURE_TTL_DAYS = 90;

type Exec = Pick<BrainEngine, 'executeRaw'>;

const jsonValue = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value;

/** The client request_id prefix of a managed capture's door writes; the attempt number follows it. */
export function appliedCaptureRequestPrefix(key: string): string {
  return `ingest-capture:${createHash('sha256').update(key).digest('hex').slice(0, 48)}:`;
}

/**
 * The stored result of the capture recorded under `key`, or null. With `journal` (a managed brain), a committed door
 * request of this capture with no row yet counts too: its row is backfilled from `journal.result(outcome)`.
 */
export async function readAppliedCapture<T>(engine: Exec, key: string,
  journal?: { sourceIds: string[]; slug: string; result: (outcome: Record<string, unknown>) => T }): Promise<T | null> {
  const [row] = await engine.executeRaw<{ result: unknown }>('SELECT result FROM ingest_applied_captures WHERE idempotency_key = $1', [key]);
  if (row) return jsonValue(row.result) as T;
  if (!journal) return null;
  const [request] = await engine.executeRaw<{ source_id: string; outcome: unknown }>(
    `SELECT source_id, outcome FROM persistence_requests
      WHERE source_id = ANY($1::text[]) AND slug = $2 AND state = 'committed' AND principal_kind = 'local_cli' AND client_request_id LIKE $3
      ORDER BY sequence LIMIT 1`,
    [journal.sourceIds, journal.slug, `${appliedCaptureRequestPrefix(key)}%`]);
  if (!request) return null;
  const result = journal.result((jsonValue(request.outcome) ?? {}) as Record<string, unknown>);
  await recordAppliedCapture(engine, key, request.source_id, journal.slug, result);
  return result;
}

/** Records the capture; false when a run of the same key already did (inside a write transaction: roll the write back). */
export async function recordAppliedCapture(exec: Exec, key: string, sourceId: string, slug: string, result: unknown): Promise<boolean> {
  const rows = await exec.executeRaw(
    `INSERT INTO ingest_applied_captures (idempotency_key, source_id, slug, result) VALUES ($1, $2, $3, $4::text::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING 1`,
    [key, sourceId, slug, JSON.stringify(result)]);
  return rows.length > 0;
}

/** Stores the final result once the import returned, inserting the row when the import wrote nothing. */
export async function saveAppliedCapture(exec: Exec, key: string, sourceId: string, slug: string, result: unknown): Promise<void> {
  await exec.executeRaw(
    `INSERT INTO ingest_applied_captures (idempotency_key, source_id, slug, result) VALUES ($1, $2, $3, $4::text::jsonb)
     ON CONFLICT (idempotency_key) DO UPDATE SET result = EXCLUDED.result`,
    [key, sourceId, slug, JSON.stringify(result)]);
}

/** 90-day GC, called from the dream cycle's purge phase. Best-effort: 0 on any failure (a brain before v296 has no table). */
export async function purgeStaleAppliedCaptures(engine: Exec, ttlDays = APPLIED_CAPTURE_TTL_DAYS): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ count: string | number }>(
      `WITH deleted AS (
         DELETE FROM ingest_applied_captures WHERE applied_at < now() - ($1 || ' days')::interval RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
      [String(ttlDays)]);
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}
