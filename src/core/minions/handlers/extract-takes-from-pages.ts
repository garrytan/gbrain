/**
 * `extract-takes-from-pages` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * v0.41.18.0 (A12, T9): extract-takes-from-pages handler. PROTECTED
 * (LLM-bearing). Two-gate consent enforced at the handler boundary:
 * refuses to run unless takes.bootstrap_enabled config is true, even
 * when allowProtectedSubmit was set at queue.add time.
 */
export function makeExtractTakesFromPagesHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { extractTakesFromPages } = await import('../../extract-takes-from-pages.ts');
    const data = (job.data ?? {}) as { sourceId?: string; maxPages?: number };
    const bootstrapCfg = await engine.getConfig('takes.bootstrap_enabled');
    const bootstrapEnabled = bootstrapCfg === 'true' || bootstrapCfg === '1';
    return await extractTakesFromPages(engine, {
      bootstrapEnabled,
      sourceIdFilter: data.sourceId,
      maxPages: data.maxPages,
    });
  };
}
