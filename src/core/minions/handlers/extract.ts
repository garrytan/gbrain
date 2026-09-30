/**
 * `extract` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { MinionQueue } from '../queue.ts';

export function makeExtractHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runExtractCore, extractStaleFromDB, STALE_TIME_BUDGET_MS } = await import('../../../commands/extract.ts');
    // #2849: stale mode — the durable follow-up for extraction deferred by
    // performSync's size gate (totalChanges > 100). Runs the same DB-source
    // watermark sweep as `gbrain extract --stale`, scoped to the source the
    // sync that deferred it was scoped to (job.data.sourceId; absent =
    // unscoped, matching what the CLI hint tells a default-brain operator
    // to run). The sweep is checkout-less + idempotent, so retries and
    // overlapping submissions converge.
    if (job.data.stale === true) {
      const sourceIdFilter = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
      const r = await extractStaleFromDB(engine, {
        dryRun: !!job.data.dryRun,
        jsonMode: false,
        sourceIdFilter,
        catchUp: false,
      });
      // Internal 30-min budget hit with work remaining → chain a
      // continuation job so a very large deferred backlog converges without
      // waiting for the next sync. Forward-progress guard (pagesProcessed >
      // 0) prevents an infinite chain if the sweep can't advance.
      if (!job.data.dryRun && r.staleRemaining > 0 && r.pagesProcessed > 0) {
        try {
          const queue = new MinionQueue(engine);
          // NO maxWaiting: with an unscoped (NULL-sourceId) payload the
          // coalesce filter matches ANY waiting 'extract' job and would
          // swallow the continuation. Each completed sweep chains at most
          // one continuation and the sweep is an idempotent watermark scan,
          // so there is no pile-up to guard against.
          await queue.add(
            'extract',
            { ...job.data, continuation_of: job.id },
            { timeout_ms: STALE_TIME_BUDGET_MS + 5 * 60 * 1000 },
          );
        } catch { /* best-effort: next sync/manual sweep picks up the rest */ }
      }
      return { stale: true, source_id: sourceIdFilter ?? null, ...r };
    }
    const mode = (typeof job.data.mode === 'string' && ['links', 'timeline', 'all'].includes(job.data.mode))
      ? (job.data.mode as 'links' | 'timeline' | 'all')
      : 'all';
    const dir = typeof job.data.dir === 'string'
      ? job.data.dir
      : (await engine.getConfig('sync.repo_path')) ?? '.';
    // #3957: thread the job's source id into the fs-walk extractors. Without
    // it the batch rows default to source_id='default' and the pages JOIN
    // drops every row on a non-'default' brain (silent "created 0"), and the
    // full-walk watermark stamp targets the wrong source.
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    return await runExtractCore(engine, { mode, dir, dryRun: !!job.data.dryRun, sourceId });
  };
}
