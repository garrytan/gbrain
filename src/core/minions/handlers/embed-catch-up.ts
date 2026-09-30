/**
 * `embed-catch-up` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { assertEmbedNotStalled } from '../../embed-stall.ts';

/**
 * v0.41.18.0 (A13): embed-catch-up handler for the gbrain onboard
 * remediation pipeline. Wraps runEmbedCore with stale + catchUp + the
 * priority/batchSize the recommendation supplies. NOT in
 * PROTECTED_JOB_NAMES (embedding spend only).
 */
export function makeEmbedCatchUpHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runEmbedCore } = await import('../../../commands/embed.ts');
    const data = (job.data ?? {}) as {
      sourceId?: string;
      batchSize?: number;
      priority?: 'recent';
      includeNullSignature?: boolean;
    };
    const catchUpResult = await runEmbedCore(engine, {
      stale: true,
      catchUp: true,
      batchSize: data.batchSize,
      priority: data.priority,
      sourceId: data.sourceId,
      // D7/D12: submitters that detected a NULL-signature cohort thread the
      // widening through; absent = grandfather clause stays (unchanged).
      includeNullSignature: !!data.includeNullSignature,
    });
    // #4599 (X6): stall abort → failed job (throw), same as the embed handler.
    assertEmbedNotStalled(catchUpResult);
    return catchUpResult;
  };
}
