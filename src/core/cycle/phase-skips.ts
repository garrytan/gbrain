import type { CyclePhase, PhaseResult } from '../cycle.ts';

/** Skip result for a filesystem phase when the brain has no on-disk checkout. */
export function skipNoBrainDir(phase: CyclePhase): PhaseResult {
  return {
    phase,
    status: 'skipped',
    duration_ms: 0,
    summary: 'requires a local brain directory; this brain has no on-disk checkout '
      + '(postgres/remote engine); pass --dir <path> to run filesystem phases',
    details: { reason: 'no_brain_dir' },
  };
}
