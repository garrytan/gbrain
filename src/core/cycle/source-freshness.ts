import type { BrainEngine } from '../engine.ts';
import type { CycleOpts, CyclePhase, CycleReport, CycleStatus, PhaseResult } from '../cycle.ts';
import { sourceCycleWindowStamp, type SourceCycleWindow } from './source-window.ts';

/** A source window may advance after its applicable phases; full freshness needs all freshness phases. */
export async function stampSourceCycle(engine: BrainEngine | null, { opts, phases, phaseResults,
  status, dryRun, aborted, sourceWindow, freshnessPhases }: {
  opts: CycleOpts; phases: CyclePhase[]; phaseResults: PhaseResult[]; status: CycleStatus;
  dryRun: boolean; aborted: boolean; sourceWindow: SourceCycleWindow | undefined; freshnessPhases: CyclePhase[];
}): Promise<{ stampWriteFailed: { source_id: string; error: string } | undefined; freshnessStamp: CycleReport['freshness_stamp'] }> {
  let stampWriteFailed: { source_id: string; error: string } | undefined;
  const coversFreshness = freshnessPhases.every(phase => phases.includes(phase));
  const attempted = phaseResults.filter(result => phases.includes(result.phase));
  const incomplete = status === 'partial' || attempted.some(result => result.status === 'fail' || result.status === 'skipped'
    || result.details?.budget_exhausted === true || Number(result.details?.pages_remaining ?? 0) > 0);
  const stampEligible = opts.sourceId && phases.length > 0 && engine && !dryRun && !aborted &&
    (status === 'ok' || status === 'clean' || status === 'partial');
  let freshnessStamp: CycleReport['freshness_stamp'] = stampEligible
    ? !coversFreshness ? 'skipped_phase_subset' : incomplete ? 'skipped_incomplete' : 'skipped'
    : 'skipped';
  if (stampEligible && !incomplete && opts.sourceId && engine) {
    try {
      const nowIso = new Date().toISOString();
      // Connector cycles select only their applicable phases and need their
      // source window to advance. That bookkeeping is not proof of a full
      // cycle: only a complete freshness phase set writes the legacy stamp.
      await engine.updateSourceConfig(opts.sourceId, {
        last_source_cycle_at: nowIso,
        ...(coversFreshness ? { last_full_cycle_at: nowIso } : {}),
        ...sourceCycleWindowStamp(phaseResults, opts.sourceChangedSince, sourceWindow),
      });
      if (coversFreshness) freshnessStamp = 'written';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Record it so `--json` consumers and the autopilot runner can see it.
      // stderr alone does not survive a cron run, which is how #2251 stayed
      // invisible while every stamp write failed for weeks.
      stampWriteFailed = { source_id: opts.sourceId, error: message };
      console.warn(`[cycle] failed to write last_source_cycle_at for source ${opts.sourceId}: ${message}`);
    }
  }

  return { stampWriteFailed, freshnessStamp };
}
