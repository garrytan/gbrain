/**
 * `lint` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

export function makeLintHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runLintCore } = await import('../../../commands/lint.ts');
    const { cycleLintExcludes } = await import('../../cycle/lint-fix-setting.ts');
    const target = typeof job.data.dir === 'string' ? job.data.dir : '.';
    // issue #1678: reuse the worker's live engine for lint's content-sanity
    // DB lift so it doesn't create + disconnect a competing engine.
    // #6134: honors cycle.lint_exclude like the cycle's lint phase.
    const result = await runLintCore({ target, fix: !!job.data.fix, dryRun: !!job.data.dryRun, engine, signal: job.signal, exclude: await cycleLintExcludes(engine) });
    return result;
  };
}
