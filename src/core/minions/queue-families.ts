/**
 * #7241: the per-queue lines of `gbrain jobs stats` (`MinionQueue.getStats().by_queue`). Dream phases mint a private
 * `dream-inline-<ms>-<uuid8>` queue per run, so a busy brain has hundreds of them; they fold into one `dream-inline`
 * row whose `queues` counts them, beside one row per named queue. `--queue <name>` still scopes the wedge lines to one.
 */
import type { BrainEngine } from '../engine.ts';

/** Waiting/active now; total/completed/failed/dead among the rows created in the window (the `by_type` semantics). */
export interface QueueFamilyStats { queue: string; queues: number; waiting_now: number; active_now: number; total: number; completed: number; failed: number; dead: number }

export function queueFamilyStats(engine: BrainEngine, since: Date): Promise<QueueFamilyStats[]> {
  return engine.readQueueFamilyStats(since);
}
