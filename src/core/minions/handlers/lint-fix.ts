/**
 * `lint-fix` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * v0.40.3.0 T8b: RemediationStep consumer handlers. Thin wrappers
 * around already-shipping CLI commands so doctor --remediate can
 * submit them as Minion jobs. NOT in PROTECTED_JOB_NAMES (no shell
 * exec, no cost spike, MCP-safe).
 */
export function makeLintFixHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runLintCore } = await import('../../../commands/lint.ts');
    const { cycleLintExcludes } = await import('../../cycle/lint-fix-setting.ts');
    const target = typeof job.data.dir === 'string' ? job.data.dir : '.';
    // issue #1678: reuse the worker's live engine (see 'lint' handler). #6134: honors cycle.lint_exclude.
    return await runLintCore({ target, fix: true, dryRun: false, engine, signal: job.signal, exclude: await cycleLintExcludes(engine) });
  };
}
