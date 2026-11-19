/**
 * #7241: the per-queue lines of `foresights jobs stats` (`MinionQueue.getStats().by_queue`). Dream phases mint a private
 * `dream-inline-<ms>-<uuid8>` queue per run, so a busy brain has hundreds of them; they fold into one `dream-inline`
 * row whose `queues` counts them, beside one row per named queue. `--queue <name>` still scopes the wedge lines to one.
 */
import type { BrainEngine } from '../engine.ts';
import { DREAM_INLINE_PRIVATE_QUEUE_PREFIX } from './queue.ts';

/** Waiting/active now; total/completed/failed/dead among the rows created in the window (the `by_type` semantics). */
export interface QueueFamilyStats { queue: string; queues: number; waiting_now: number; active_now: number; total: number; completed: number; failed: number; dead: number }

export async function queueFamilyStats(engine: BrainEngine, since: Date): Promise<QueueFamilyStats[]> {
  const rows = await engine.executeRaw<Record<string, string>>(
    `SELECT CASE WHEN queue LIKE '${DREAM_INLINE_PRIVATE_QUEUE_PREFIX}%' THEN '${DREAM_INLINE_PRIVATE_QUEUE_PREFIX.slice(0, -1)}' ELSE queue END AS queue,
       count(DISTINCT queue)::text AS queues,
       count(*) FILTER (WHERE status = 'waiting')::text AS waiting_now,
       count(*) FILTER (WHERE status = 'active')::text AS active_now,
       count(*) FILTER (WHERE created_at >= $1)::text AS total,
       count(*) FILTER (WHERE created_at >= $1 AND status = 'completed')::text AS completed,
       count(*) FILTER (WHERE created_at >= $1 AND status = 'failed')::text AS failed,
       count(*) FILTER (WHERE created_at >= $1 AND status = 'dead')::text AS dead
     FROM minion_jobs WHERE created_at >= $1 OR status IN ('waiting', 'active')
     GROUP BY 1 ORDER BY 1`,
    [since.toISOString()],
  );
  return rows.map(r => ({ queue: r.queue!, queues: Number(r.queues), waiting_now: Number(r.waiting_now), active_now: Number(r.active_now),
    total: Number(r.total), completed: Number(r.completed), failed: Number(r.failed), dead: Number(r.dead) }));
}
