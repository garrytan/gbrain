/**
 * Phase-wrapper Minion job handlers (built-in; registered by registerBuiltinHandlers in
 * src/commands/jobs.ts for synthesize, patterns, consolidate, extract_facts,
 * resolve_symbol_edges and recompute_emotional_weight).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * Phase-wrapper handlers — each delegates to runCycle({ phases: [name] }).
 * Cycle owns the lock + abort signal + progress reporter per D10.
 * Smaller diff than full standalone phase extraction; cycle.ts remains
 * the single source of truth for phase semantics.
 */
export function makeCyclePhaseHandler(engine: BrainEngine, phase: string): MinionHandler {
  return async (job: any) => {
    const { runCycle } = await import('../../cycle.ts');
    // v0.41.38 (codex P2 review): fall back to null (NOT cwd '.') when no repo
    // is configured, matching the autopilot-cycle handler + `gbrain dream`. On a
    // checkout-less postgres brain a filesystem phase (synthesize/patterns/...)
    // skips with reason 'no_brain_dir' instead of running against the worker cwd;
    // DB-only phases (resolve_symbol_edges/embed/...) ignore brainDir either way.
    const repoPath: string | null = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : ((await engine.getConfig('sync.repo_path')) ?? null);
    const report = await runCycle(engine, {
      brainDir: repoPath,
      phases: [phase as any],
      signal: job.signal,
      deadlineAtMs: job.deadlineAtMs, // #2781: phases budget sub-work from remaining time
      privateQueueOwnerJobId: job.id,
    });
    return { phase, status: report.status, report };
  };
}
