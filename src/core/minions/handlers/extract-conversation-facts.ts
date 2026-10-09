/**
 * `extract-conversation-facts` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
// Leaf module (no flag surface of its own) — see that file for why this
// isn't imported from extract-conversation-facts.ts directly (#4135).
import { ALLOWED_TYPES, type AllowedType } from '../../facts/conversation-types.ts';

/**
 * v0.41.11.0 — extract-conversation-facts. NOT in PROTECTED_JOB_NAMES
 * because per-call cost is bounded by `data.max_cost_usd` (default
 * DEFAULT_MAX_COST_USD = $5) and the handler re-creates the
 * BudgetTracker inside its own process. BudgetExhausted is caught at
 * the core level and returned as `result.budget_exhausted: true` (NOT
 * a job failure) so the user can resume with a higher cap.
 */
export function makeExtractConversationFactsHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runExtractConversationFactsCore } = await import('../../../commands/extract-conversation-facts.ts');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!sourceId) {
      // Multi-source iteration not supported in the Minion-handler path;
      // the CLI wrapper does multi-source loops. A background submission
      // SHOULD pin to one source per call (job_id is per-call).
      throw new Error('extract-conversation-facts Minion job requires data.sourceId');
    }
    // ALLOWED_TYPES is the single source of truth for the conversation-facts
    // type allowlist (see src/core/facts/conversation-types.ts).
    const types = Array.isArray(job.data.types)
      ? (job.data.types as string[]).filter(
          (t): t is AllowedType => (ALLOWED_TYPES as readonly string[]).includes(t),
        )
      : undefined;
    const result = await runExtractConversationFactsCore(engine, {
      sourceId,
      types,
      slug: typeof job.data.slug === 'string' ? job.data.slug : undefined,
      slugs: Array.isArray(job.data.slugs) ? (job.data.slugs as unknown[]).filter((v): v is string => typeof v === 'string') : undefined,
      dryRun: !!job.data.dryRun,
      limit: typeof job.data.limit === 'number' ? job.data.limit : undefined,
      sinceIso: typeof job.data.sinceIso === 'string' ? job.data.sinceIso : undefined,
      force: !!job.data.force,
      sleepMs: typeof job.data.sleepMs === 'number' ? job.data.sleepMs : undefined,
      segmentLimit: typeof job.data.segmentLimit === 'number' ? job.data.segmentLimit : undefined,
      maxCostUsd: typeof job.data.maxCostUsd === 'number' ? job.data.maxCostUsd : undefined,
      overrideDisabled: !!job.data.overrideDisabled,
      // v0.41.15.0 (D9): round-trip --workers via job.data.workers so
      // `gbrain extract-conversation-facts --background --workers 20`
      // works end-to-end.
      workers: typeof job.data.workers === 'number' ? job.data.workers : undefined,
    });
    return result;
  };
}
