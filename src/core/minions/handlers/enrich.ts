/**
 * `enrich` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * v0.41.39 (#1700) — enrich. NOT in PROTECTED_JOB_NAMES: per-call cost is
 * bounded by data.maxCostUsd (default DEFAULT_MAX_COST_USD) and the handler
 * re-creates the BudgetTracker in its own process. BudgetExhausted is caught
 * at the core level and returned as result.budget_exhausted (NOT a failure).
 * Strict per-source: the CLI fans out one job per source when --source is
 * omitted, so a job ALWAYS carries data.sourceId.
 */
export function makeEnrichHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runEnrichCore } = await import('../../../commands/enrich.ts');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!sourceId) {
      throw new Error('enrich Minion job requires data.sourceId (CLI fans out one job per source)');
    }
    const types = Array.isArray(job.data.types)
      ? (job.data.types as string[])
      : undefined;
    const order = typeof job.data.order === 'string' ? job.data.order : undefined;
    const result = await runEnrichCore(engine, {
      sourceId,
      types: types as import('../../types.ts').PageType[] | undefined,
      order: order as ('inbound-links' | 'salience' | 'updated') | undefined,
      limit: typeof job.data.limit === 'number' ? job.data.limit : undefined,
      workers: typeof job.data.workers === 'number' ? job.data.workers : undefined,
      model: typeof job.data.model === 'string' ? job.data.model : undefined,
      maxCostUsd: typeof job.data.maxCostUsd === 'number' ? job.data.maxCostUsd : undefined,
      minContextChars: typeof job.data.minContextChars === 'number' ? job.data.minContextChars : undefined,
      thinThreshold: typeof job.data.thinThreshold === 'number' ? job.data.thinThreshold : undefined,
      reenrichAfterMs: typeof job.data.reenrichAfterMs === 'number' ? job.data.reenrichAfterMs : undefined,
      dryRun: !!job.data.dryRun,
      force: !!job.data.force,
    });
    return result;
  };
}
