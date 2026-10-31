/**
 * #7242: an append-only cursor over terminal job events, so an agent polls once for every job that finished
 * instead of once per job. A job is an event when it reaches completed, failed, dead or cancelled; the cursor
 * orders on (finished_at, id) at microsecond precision, so a page boundary never repeats or skips a row.
 * A retried job that finishes again is a new event at its new finished_at. Rows deleted on completion
 * (remove_on_complete / remove_on_fail) and pruned rows are not events.
 */
import type { BrainEngine } from '../engine.ts';
import { jobActorSql, NO_JOB_ACTOR, rowToMinionJob, type JobActor, type MinionJob } from './types.ts';

export class TerminalCursorError extends Error {
  constructor(message: string) { super(message); this.name = 'TerminalCursorError'; }
}

/** `<finished_at epoch microseconds>:<job id>`, or an ISO time (every event at or after it). */
export function parseTerminalCursor(raw: string): { micros: string; id: number } {
  const value = raw.trim();
  const m = /^(\d{1,19}):(\d{1,12})$/.exec(value);
  if (m) return { micros: m[1], id: Number(m[2]) };
  const ms = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(ms)) throw new TerminalCursorError('finished_since must be an ISO time or a next_cursor value (<micros>:<id>).');
  return { micros: String(BigInt(ms) * 1000n - 1n), id: Number.MAX_SAFE_INTEGER };
}

const FINISHED_US = "(EXTRACT(EPOCH FROM finished_at) * 1000000)::bigint";

export async function listFinishedSince(engine: BrainEngine, since: string, opts: { queue?: string; name?: string; limit?: number; ownerClientId?: string; ownerActor?: JobActor } = {}): Promise<{ jobs: MinionJob[]; next_cursor: string }> {
  const cursor = parseTerminalCursor(since);
  const params: unknown[] = [cursor.micros, cursor.id];
  const where = [
    "status IN ('completed', 'failed', 'dead', 'cancelled')", 'finished_at IS NOT NULL',
    `finished_at >= to_timestamp($1::bigint / 1000000.0) - interval '1 second'`,
    `(${FINISHED_US}, id) > ($1::bigint, $2::bigint)`,
  ];
  if (opts.queue) { params.push(opts.queue); where.push(`queue = $${params.length}`); }
  if (opts.name) { params.push(opts.name); where.push(`name = $${params.length}`); }
  if (opts.ownerClientId) {
    params.push(opts.ownerClientId); where.push(`data->>'__owner_client_id' = $${params.length}`);
    where.push(jobActorSql(params.length + 1)); params.push(...(opts.ownerActor ?? NO_JOB_ACTOR));
  }
  params.push(Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50))));
  const rows = await engine.executeRaw<Record<string, unknown> & { finished_us: string | number }>(
    `SELECT *, ${FINISHED_US}::text AS finished_us FROM minion_jobs WHERE ${where.join(' AND ')}
      ORDER BY finished_at ASC, id ASC LIMIT $${params.length}`, params);
  const last = rows[rows.length - 1];
  return {
    jobs: rows.map(rowToMinionJob),
    next_cursor: last ? `${last.finished_us}:${Number(last.id)}` : `${cursor.micros}:${cursor.id}`,
  };
}
