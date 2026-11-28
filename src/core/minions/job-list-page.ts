/**
 * list_jobs paging: one page of jobs, newest first, ordered on (created_at, id) at microsecond precision so a
 * page boundary never repeats or skips a row. One extra row is read to know whether more remain; next_cursor
 * resumes after the last row returned. The per-call cap for remote callers lives in ops/read-paging.ts.
 */
import type { BrainEngine } from '../engine.ts';
import { rowToMinionJob, type JobOwner, type MinionJob } from './types.ts';

export class JobListCursorError extends Error {
  constructor(message: string) { super(message); this.name = 'JobListCursorError'; }
}

/** `<created_at epoch microseconds>:<job id>`, the next_cursor of the previous page. */
export function parseJobListCursor(raw: string): { micros: string; id: number } {
  const m = /^(\d{1,19}):(\d{1,15})$/.exec(raw.trim());
  if (!m || !Number.isSafeInteger(Number(m[2]))) throw new JobListCursorError('cursor must be the next_cursor value of the previous page (<micros>:<id>).');
  return { micros: m[1], id: Number(m[2]) };
}

export async function listJobPage(engine: BrainEngine, opts: {
  status?: string; queue?: string; name?: string; owner?: JobOwner; limit: number; cursor?: string;
}): Promise<{ jobs: MinionJob[]; next_cursor?: string }> {
  const rows = await engine.listJobPage({
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.queue ? { queue: opts.queue } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.owner ? { owner: opts.owner } : {}),
    limit: opts.limit + 1,
    cursor: opts.cursor !== undefined ? parseJobListCursor(opts.cursor) : null,
  });
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    jobs: page.map(rowToMinionJob),
    ...(rows.length > opts.limit && last ? { next_cursor: `${last.created_us}:${Number(last.id)}` } : {}),
  };
}
