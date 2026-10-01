/**
 * `backlinks` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

export function makeBacklinksHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runBacklinksCore } = await import('../../../commands/backlinks.ts');
    // Default to 'check', not 'fix': backlinks jobs submitted with an empty
    // payload (e.g. the sync→embed→backlinks chains enqueued after ingestion)
    // must never rewrite tracked brain pages with generated "Referenced in"
    // timeline bullets. Mirrors the documented intent in src/core/cycle.ts
    // (runPhaseBacklinks). The filesystem fixer stays available explicitly
    // via '{"action":"fix"}' or `gbrain check-backlinks fix`.
    const action: 'check' | 'fix' = job.data.action === 'fix' ? 'fix' : 'check';
    const dir = typeof job.data.dir === 'string'
      ? job.data.dir
      : (await engine.getConfig('sync.repo_path')) ?? '.';
    return await runBacklinksCore({ action, dir, dryRun: !!job.data.dryRun });
  };
}
