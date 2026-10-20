/**
 * GBRA-133 PR 2a: the wanted-marker handoff for a drainer that is not the notifier (the `sync` job handler, the serve's
 * delegated runner). Read the markers before the run, settle them after it (generation-checked, store.ts), and start
 * at most one follow-up for whatever is still due: a queued job (maxWaiting 1, so it never coalesces into the job that
 * is finishing) where a queue drains jobs, else a nudge to this process's notifier. A run that finds the source busy
 * records a marker instead of dropping its commit. Every step is best effort: the run's own result never depends on it,
 * and the residents' durable marker scan drains anything left behind (a marker that lands after this re-check).
 */
import type { BrainEngine } from '../engine.ts';
import { attachMarkerJob, missingTable, readDueMarkers, settleMarkers, type WantedMarker } from './store.ts';

export async function readMarkersForRun(engine: BrainEngine, sourceId: string): Promise<WantedMarker[]> {
  try { return await readDueMarkers(engine, [sourceId]); } catch (error) { if (!missingTable(error)) console.error(`[sync] reading wanted markers of ${sourceId} failed: ${error instanceof Error ? error.message : String(error)}`); return []; }
}

/** After a completed run: clears what it satisfied; queues one follow-up job when something is still due. Returns that job. */
export async function settleRunMarkers(engine: BrainEngine, sourceId: string, read: WantedMarker[], run: { pulled: boolean; full: boolean }, opts: { queue?: boolean } = {}): Promise<{ job_id: number | null; markers: number } | null> {
  try {
    const remaining = await settleMarkers(engine, sourceId, read, run);
    if (!remaining.length) return null;
    if (opts.queue === false || engine.kind === 'pglite') {
      (await import('./resident.ts')).nudgeResidentNotifier();
      return { job_id: null, markers: remaining.length };
    }
    const { MinionQueue } = await import('../minions/queue.ts');
    const pull = remaining.some(m => m.intent === 'pull');
    const job = await new MinionQueue(engine).add('sync', { sourceId, ...(pull ? {} : { noPull: true }), noExtract: false, auto_embed_backfill: true, embed_reason: 'marker_follow_up' },
      { priority: -10, maxWaiting: 1 });
    for (const m of remaining) await attachMarkerJob(engine, sourceId, m.intent, m.generation, job.id);
    return { job_id: job.id, markers: remaining.length };
  } catch (error) {
    if (!missingTable(error)) console.error(`[sync] settling wanted markers of ${sourceId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** A run that found another sync draining the source records what it wanted; the holder's re-check (or a resident) runs it. */
export async function recordBusyMarker(engine: BrainEngine, sourceId: string, opts: { pull: boolean }): Promise<void> {
  try {
    const { recordTriggerMarker } = await import('./nudge.ts');
    await recordTriggerMarker(engine, { sourceId, intent: opts.pull ? undefined : 'freshness', requestedBy: 'lock_busy' });
  } catch (error) {
    if (!missingTable(error)) console.error(`[sync] recording a wanted marker for ${sourceId} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
