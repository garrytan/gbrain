/**
 * The per-source freshness stamp gate.
 *
 * `last_source_cycle_at` / `last_full_cycle_at` tell autopilot a source is
 * done; a stamp backs off dispatch for a full freshness window and clears the
 * failure cooldown. A cycle status of 'partial' is NOT enough to stamp: it
 * covers warn-only runs (which persisted their work and must stamp, or they
 * would rerun every tick) AND runs where `sync` hard-failed next to a lint
 * that passed (which must not — that marked a failed source fresh).
 *
 * Only a hard failure ('fail') of one of the deterministic
 * SOURCE_FRESHNESS_PHASES holds the stamp. A full default-source cycle also
 * runs mixed, global and background phases (embed throws on every keyless
 * brain); those have their own lane or none and must never hold the source
 * stamp hostage. The global lane keeps its own gate
 * (minions/handlers/autopilot-global-maintenance.ts).
 */
import type { CycleStatus, PhaseResult } from '../cycle.ts';
import { SOURCE_FRESHNESS_PHASES } from './phase-scope.ts';

/** Freshness phases that hard-failed, so the source still has work due. Empty means it may stamp. */
export function sourcePhasesLeavingWorkDue(phases: PhaseResult[]): string[] {
  return phases
    .filter((phase) => phase.status === 'fail' && SOURCE_FRESHNESS_PHASES.includes(phase.phase))
    .map((phase) => phase.phase);
}

export interface SourceStampInput {
  sourceId?: string;
  phaseCount: number;
  hasEngine: boolean;
  dryRun: boolean;
  aborted: boolean;
  status: CycleStatus;
  phaseResults: PhaseResult[];
}

/**
 * `stamp`: write the freshness stamp. `withheldFor`: set only when a stamp was
 * otherwise due but a freshness phase failed (never for dry-run, aborted,
 * failed or skipped runs), so the failure cooldown can count the run.
 */
export function decideSourceStamp(input: SourceStampInput): { stamp: boolean; withheldFor?: string[] } {
  const stampDue = !!input.sourceId && input.phaseCount > 0 && input.hasEngine && !input.dryRun && !input.aborted
    && (input.status === 'ok' || input.status === 'clean' || input.status === 'partial');
  if (!stampDue) return { stamp: false };
  const workDue = sourcePhasesLeavingWorkDue(input.phaseResults);
  return workDue.length > 0 ? { stamp: false, withheldFor: workDue } : { stamp: true };
}
