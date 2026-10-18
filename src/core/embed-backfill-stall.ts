/**
 * #6803 (1): bounded retry for an embed-backfill that keeps failing the same
 * way without progress.
 *
 * A backfill whose only remaining work sits on pages it cannot project (a
 * `rebuild_failed` projection, an image page only its importer rebuilds) ends
 * `incomplete` and dead-letters, and every automatic submitter (a sync that
 * imported content, a connector's large-sync defer, a federation flip) queued
 * the next one as soon as the 10-minute cooldown passed: the same failure 96
 * times a day with nothing embedded. Each such run now records its blocker
 * fingerprint in the job's progress (`stall`). `submitEmbedBackfill` reads
 * the streak of identical no-progress failures for the source, backs off
 * (cooldown x2 per failure) and, at `EMBED_BACKFILL_STALL_LIMIT`, stops
 * submitting. Any change re-arms it: a run that embedded something or
 * completed ends the streak, and a different fingerprint (new stale chunks, a
 * blocker repaired or added) lets the next submission through. Explicit runs
 * (`gbrain embed --stale`, `gbrain jobs submit embed-backfill`) never pass
 * through this gate. doctor `embed_backfill_stalled` names the blocking pages.
 */
import type { BrainEngine } from './engine.ts';
import { digest } from './persistence/digest.ts';
import { countArchivedEmbeddingWork, listPendingProjectionPages } from './embedding-readiness.ts';

/** Identical no-progress failed jobs after which automatic submission stops for the source. */
export const EMBED_BACKFILL_STALL_LIMIT = 3;

/** What a no-progress run recorded, and what a submitter recomputes to compare. */
export interface EmbedBackfillBlockers {
  fingerprint: string;
  /** Stale chunks left in the source. */
  remaining: number;
  /** Pages still waiting for a text projection, plus archived pages with embedding work. */
  blocked: number;
  /** The embedding signature the run drained under; a submitter recomputes with the same one. */
  signature: string | null;
}

export interface EmbedBackfillBlockerPage { source_id: string; slug: string; page_kind: string }

/**
 * The source's current blockers: the stale-chunk count, the pages still
 * waiting for a projection (as the backfill's own readiness pass selects
 * them) and archived embedding work. Pages are listed for the fingerprint and
 * for doctor; at most 1000 are read.
 */
export async function readEmbedBackfillBlockers(engine: BrainEngine, sourceId: string, signature: string | null):
  Promise<EmbedBackfillBlockers & { pages: EmbedBackfillBlockerPage[] }> {
  const sig = signature ?? undefined;
  const remaining = await engine.countStaleChunks({ sourceId, ...(sig && { signature: sig }) });
  const archived = await countArchivedEmbeddingWork(engine, { sourceId, signature: sig });
  const pages = await listPendingProjectionPages(engine, { sourceId, existingChunksOnly: true, activeSourcesOnly: true, stale: { signature: sig } });
  return {
    fingerprint: digest({ remaining, archived, pages: pages.map(p => `${p.source_id}::${p.slug}`) }),
    remaining,
    blocked: pages.length + archived,
    signature,
    pages,
  };
}

export interface EmbedBackfillStall extends EmbedBackfillBlockers {
  /** Consecutive most recent finished jobs that failed with this fingerprint and embedded nothing. */
  failures: number;
  /** When the most recent of them finished. */
  last_finished_at: Date;
}

/** The source's current streak of identical no-progress failures, or null when its latest finished backfill is not one. */
export async function readEmbedBackfillStall(engine: BrainEngine, sourceId: string): Promise<EmbedBackfillStall | null> {
  const rows = await engine.executeRaw<{ status: string; finished_at: Date | string | null; stall: EmbedBackfillBlockers | null }>(
    `SELECT status, finished_at, progress->'stall' AS stall
       FROM minion_jobs
      WHERE name = 'embed-backfill' AND data->>'sourceId' = $1 AND status IN ('completed', 'failed', 'dead', 'cancelled')
      ORDER BY id DESC LIMIT $2`,
    [sourceId, EMBED_BACKFILL_STALL_LIMIT],
  );
  const first = rows[0];
  if (!first?.stall?.fingerprint || !first.finished_at || (first.status !== 'dead' && first.status !== 'failed')) return null;
  let failures = 0;
  for (const row of rows) {
    if ((row.status !== 'dead' && row.status !== 'failed') || row.stall?.fingerprint !== first.stall.fingerprint) break;
    failures++;
  }
  return { ...first.stall, signature: first.stall.signature ?? null, failures, last_finished_at: new Date(first.finished_at) };
}
