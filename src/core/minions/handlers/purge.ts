/**
 * `purge` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

export function makePurgeHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const scope = (typeof job.data.scope === 'string' && ['pages', 'sources', 'all'].includes(job.data.scope))
      ? (job.data.scope as 'pages' | 'sources' | 'all')
      : 'all';
    const olderThanHours = typeof job.data.olderThanHours === 'number' ? job.data.olderThanHours : 72;
    const dryRun = !!job.data.dryRun;
    let pagesPurged = 0;
    let pagesBlocked: Array<{ source_id: string; slug: string; reason: string }> = [];
    let pagesError: string | undefined;
    let sourcesPurged: string[] = [];
    if (scope === 'pages' || scope === 'all') {
      const result = await (await import('../../persistence/purge-deleted.ts')).purgeDeletedPagesCoordinated(engine, olderThanHours);
      pagesPurged = result.count; pagesBlocked = result.blocked; pagesError = result.error?.message;
    }
    let sourcesBlocked: Array<{ id: string; reason: string }> = [];
    if (scope === 'sources' || scope === 'all') {
      const { purgeExpiredSources } = await import('../../destructive-guard.ts');
      const purgeResult = await purgeExpiredSources(engine);
      sourcesPurged = purgeResult.purged;
      sourcesBlocked = purgeResult.blocked;
    }
    // GC stale op_checkpoints rows (folded scope item +C from review).
    const { purgeStaleCheckpoints } = await import('../../op-checkpoint.ts');
    const checkpointsPurged = await purgeStaleCheckpoints(engine, 7);
    // #5405: a coordinated purge failure fails the job after the other purges ran.
    if (pagesError) throw new Error(pagesError);
    return { pagesPurged, pagesBlocked, sourcesPurged, sourcesBlocked, checkpointsPurged, dryRun };
  };
}
