/**
 * `autopilot-global-maintenance` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * Brain-wide maintenance. Runs mixed + global phases ONCE per window instead
 * of repeating cross-source transcript/reflection reads in every source.
 * No source_id → uses the legacy global cycle lock; stamps autopilot.last_global_at
 * on success so the dispatch gate backs off.
 */
export function makeAutopilotGlobalMaintenanceHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runCycle, MAINTENANCE_PHASES, LAST_GLOBAL_AT_KEY } = await import('../../cycle.ts');
    const repoPath: string | null = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : (await engine.getConfig('sync.repo_path')) ?? null;

    // #4250: queued maintenance payloads are machine-authored too — intersect
    // with MAINTENANCE_PHASES so a stale (or remote-submitted) payload can't
    // run source-scoped phases through the global lane, symmetric with the
    // per-source normalization in the autopilot-cycle handler.
    const maintenanceSet = new Set<string>(MAINTENANCE_PHASES);
    const requested = Array.isArray(job.data.phases)
      ? (job.data.phases as string[]).filter((p) => maintenanceSet.has(p))
      : MAINTENANCE_PHASES;
    const phases = (requested.length > 0 ? requested : MAINTENANCE_PHASES) as typeof MAINTENANCE_PHASES;

    const report = await runCycle(engine, {
      brainDir: repoPath,
      pull: false, // brain-wide DB/maintenance work never git-pulls
      signal: job.signal,
      deadlineAtMs: job.deadlineAtMs, // #2781: phases budget sub-work from remaining time
      // The maintenance lane is where synthesize/patterns actually run on
      // multi-source brains (per-source payloads normalize down to the
      // freshness phases) — without the owner id its private queues would be
      // owner-less and recovery would degrade to lease-expiry only.
      privateQueueOwnerJobId: job.id,
      phases,
      forceGlobalOrphans: true,
      yieldBetweenPhases: async () => { await new Promise<void>((r) => setImmediate(r)); },
    });

    if ((report.status === 'ok' || report.status === 'clean' || report.status === 'partial')
      && !report.phases.some(phase => {
        if (phase.status === 'fail') return true;
        if (phase.phase !== 'synthesize' && phase.phase !== 'patterns') return false;
        if (phase.details.reason === 'insufficient_cycle_budget') return true;
        if (phase.phase === 'patterns') {
          return typeof phase.details.child_outcome === 'string' && phase.details.child_outcome !== 'completed';
        }
        const synthesis = phase.details.synthesis as { non_completed_jobs?: number } | undefined;
        const triage = phase.details.triage as { deferred?: number } | undefined;
        return (synthesis?.non_completed_jobs ?? 0) > 0
          || (triage?.deferred ?? 0) > 0
          || (Array.isArray(phase.details.budget_deferred_transcripts) && phase.details.budget_deferred_transcripts.length > 0);
      })
      && report.reason !== 'aborted' && report.reason !== 'lock_stolen') {
      try {
        await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date().toISOString());
      } catch (e) {
        console.warn(`[autopilot-global-maintenance] failed to stamp last_global_at: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      partial: report.status === 'partial' || report.status === 'failed',
      status: report.status,
      report,
    };
  };
}
