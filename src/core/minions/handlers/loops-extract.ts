/**
 * `loops_extract` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * Open-loop commitment/decision extraction over google-source email pages
 * (src/core/google/loops-extract.ts). Enqueued by runGoogleSync on trickle
 * threads within the recent window, idempotency-keyed per page revision,
 * capped per sweep. Kill switch: config loops.extraction_enabled.
 */
export function makeLoopsExtractHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const slug = typeof job.data.slug === 'string' ? job.data.slug : undefined;
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!slug || !sourceId) throw new Error('loops_extract job requires data.slug and data.sourceId');
    const threadId = typeof job.data.threadId === 'string' ? job.data.threadId : undefined;
    const { runLoopsExtract } = await import('../../google/loops-extract.ts');
    const result = await runLoopsExtract(engine, { slug, sourceId, ...(threadId ? { threadId } : {}), ...(job.data.sourceKind === 'apple' ? { sourceKind: 'apple' as const } : {}) });
    // #5867 (E9): the revision-bound outcome is the catch-up's evidence, not job completion.
    // A failed record never fails the job (that would repeat a paid extraction); the catch-up then re-checks the thread.
    try {
      const { loopsExtractRevision, recordLoopsExtractOutcome } = await import('../../google/loop-catchup.ts');
      const rev = await loopsExtractRevision(engine, sourceId, slug, job.data.newestMs);
      if (rev !== null) {
        await recordLoopsExtractOutcome(engine, sourceId, slug, {
          rev, outcome: result.status === 'extracted' ? 'extracted' : `${result.status}:${result.reason ?? 'unknown'}`, catchup: job.data.catchup === true,
        });
      }
    } catch (e) {
      console.warn(`[loops_extract] could not record the outcome for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return result;
  };
}
