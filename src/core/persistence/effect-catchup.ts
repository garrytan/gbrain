/**
 * GBRA-133: an effect catch-up that is not progressing. Effects that find their worktree held by another writer retry as
 * `writer_busy` with a backoff (effect-journal.ts `retryBusyEffect`), which records when each one's busy streak began.
 * This reads, per source, the effects that have waited on the worktree for over `CATCHUP_STALL_MS` without one take:
 * ordinary writes may still commit beside them, but this backlog does not move. Read by doctor (`parked_effects`) and
 * `gbrain sources writer status`.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { readFix } from '../ops/op-fix.ts';

/** How long an effect may wait on a busy worktree before its catch-up counts as not progressing. */
export const CATCHUP_STALL_MS = 10 * 60_000;

export interface StalledCatchup {
  source_id: string;
  /** Effects queued on `writer_busy` whose busy streak began over `CATCHUP_STALL_MS` ago. */
  stalled_effects: number;
  /** All effects of the source queued on `writer_busy` now. */
  busy_effects: number;
  /** When the oldest stalled effect's busy streak began. */
  busy_since: string;
  /** The longest busy streak (consecutive `writer_busy` retries) among them. */
  busy_retries: number;
  fix: Action;
}

export async function readStalledCatchups(engine: BrainEngine, sourceIds?: string[], stallMs = CATCHUP_STALL_MS): Promise<StalledCatchup[]> {
  const rows = await engine.executeRaw<{ source_id: string; stalled: number; busy: number; since: string | Date; retries: number }>(
    `SELECT e.source_id,
            count(*) FILTER (WHERE (e.data->>'busy_since')::timestamptz < now() - ($2::double precision * interval '1 millisecond'))::int AS stalled,
            count(*)::int AS busy, min((e.data->>'busy_since')::timestamptz) AS since, COALESCE(max((e.data->>'busy_retries')::int), 0)::int AS retries
       FROM persistence_effects e
      WHERE e.state='queued' AND e.error_code='writer_busy' AND e.data ? 'busy_since' AND ($1::text[] IS NULL OR e.source_id=ANY($1::text[]))
      GROUP BY e.source_id ORDER BY e.source_id`, [sourceIds ?? null, stallMs]);
  return rows.filter(row => Number(row.stalled) > 0).map(row => ({
    source_id: row.source_id, stalled_effects: Number(row.stalled), busy_effects: Number(row.busy), busy_since: new Date(row.since).toISOString(),
    busy_retries: Number(row.retries),
    fix: readFix(`Lists the processes on this host that hold or wait for source ${row.source_id}'s canonical worktree, and its retrying effects, read-only. `
      + 'A process that keeps the worktree for minutes at a time (a long sync or a stuck job) is what this backlog waits behind.',
      { argv: ['gbrain', 'sources', 'writer', 'status', '--source', row.source_id, '--json'] }),
  }));
}
