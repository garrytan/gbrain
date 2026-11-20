/**
 * Raw-row seeds for the N3 read-move tests (test/n3-sql-move-parity.test.ts, test/engine-parity/jobs-health.test.ts).
 *
 * BrainEngine has no typed job writer on this base, so job rows go in through `executeRaw`: one INSERT per row with
 * every time given as an offset from `now()`, so a case puts a row inside or outside a window without waiting out a
 * clock. Rows carry an application submission authority, which the queue-protocol trigger requires. SQL arms only; the Rust arm has no raw SQL.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export interface JobSeed {
  name: string;
  queue?: string;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'dead' | 'cancelled' | 'paused';
  /** Offsets from now(), as Postgres interval text, e.g. '-2 hours'. */
  created?: string;
  started?: string;
  finished?: string;
  updated?: string;
  lockUntil?: string;
  delayUntil?: string;
  errorText?: string;
  idempotencyKey?: string;
  data?: Record<string, unknown>;
  stalledCounter?: number;
}

/** Insert `jobs` in order; returns their ids in the same order. */
export async function seedJobs(engine: BrainEngine, jobs: readonly JobSeed[]): Promise<number[]> {
  const ids: number[] = [];
  for (const j of jobs) {
    const at = (offset: string | undefined) => (offset === undefined ? null : offset);
    const rows = await engine.executeRaw<{ id: number | string }>(
      `INSERT INTO minion_jobs (name, queue, status, created_at, started_at, finished_at, updated_at, lock_until, delay_until, error_text,
         idempotency_key, data, stalled_counter, submission_authority)
       VALUES ($1, $2, $3, now() + COALESCE($4::text, '0 seconds')::interval,
         CASE WHEN $5::text IS NULL THEN NULL ELSE now() + $5::text::interval END,
         CASE WHEN $6::text IS NULL THEN NULL ELSE now() + $6::text::interval END,
         now() + COALESCE($7::text, $6::text, '0 seconds')::interval,
         CASE WHEN $8::text IS NULL THEN NULL ELSE now() + $8::text::interval END,
         CASE WHEN $9::text IS NULL THEN NULL ELSE now() + $9::text::interval END,
         $10, $11, $12::text::jsonb, $13, '{"kind":"application"}'::jsonb) RETURNING id`,
      [j.name, j.queue ?? 'default', j.status, at(j.created), at(j.started), at(j.finished), at(j.updated), at(j.lockUntil), at(j.delayUntil),
        j.errorText ?? null, j.idempotencyKey ?? null, JSON.stringify(j.data ?? {}), j.stalledCounter ?? 0]);
    ids.push(Number(rows[0]!.id));
  }
  return ids;
}
