/**
 * list_jobs paging: one page of jobs, newest first, ordered on (created_at, id) at microsecond precision so a
 * page boundary never repeats or skips a row. One extra row is read to know whether more remain; next_cursor
 * resumes after the last row returned. The per-call cap for remote callers lives in ops/read-paging.ts.
 */
import type { BrainEngine } from '../engine.ts';
import { rowToMinionJob, type MinionJob } from './types.ts';

export class JobListCursorError extends Error {
  constructor(message: string) { super(message); this.name = 'JobListCursorError'; }
}

const CREATED_US = '(EXTRACT(EPOCH FROM created_at) * 1000000)::bigint';

/** `<created_at epoch microseconds>:<job id>`, the next_cursor of the previous page. */
export function parseJobListCursor(raw: string): { micros: string; id: number } {
  const m = /^(\d{1,19}):(\d{1,15})$/.exec(raw.trim());
  if (!m || !Number.isSafeInteger(Number(m[2]))) throw new JobListCursorError('cursor must be the next_cursor value of the previous page (<micros>:<id>).');
  return { micros: m[1], id: Number(m[2]) };
}

export async function listJobPage(engine: BrainEngine, opts: {
  status?: string; queue?: string; name?: string; ownerClientId?: string; limit: number; cursor?: string;
}): Promise<{ jobs: MinionJob[]; next_cursor?: string }> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.cursor !== undefined) {
    const cursor = parseJobListCursor(opts.cursor);
    params.push(cursor.micros, cursor.id);
    where.push(`(${CREATED_US}, id) < ($1::bigint, $2::bigint)`);
  }
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.queue) { params.push(opts.queue); where.push(`queue = $${params.length}`); }
  if (opts.name) { params.push(opts.name); where.push(`name = $${params.length}`); }
  if (opts.ownerClientId) { params.push(opts.ownerClientId); where.push(`data->>'__owner_client_id' = $${params.length}`); }
  params.push(opts.limit + 1);
  const rows = await engine.executeRaw<Record<string, unknown> & { created_us: string | number }>(
    `SELECT *, ${CREATED_US}::text AS created_us FROM minion_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    jobs: page.map(rowToMinionJob),
    ...(rows.length > opts.limit && last ? { next_cursor: `${last.created_us}:${Number(last.id)}` } : {}),
  };
}
