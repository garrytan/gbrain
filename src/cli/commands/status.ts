/**
 * `gbrain status`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { BrainEngine } from '../../core/engine.ts';

// v0.41.19.0 — `gbrain status`: single-screen brain health dashboard.
// CLI-only with own thin-client branch INSIDE runStatus (per D2 + codex
// MAJOR-4 architecture). Composes existing exports: buildSyncStatusReport,
// readSupervisorEvents, gbrain_cycle_locks, minion_jobs.
export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runStatus } = await import('../../commands/status.ts');
  const result = await runStatus(engine, args);
  // #2084 inner-exit sweep: a mid-switch exit skips the finally teardown.
  setCliExitVerdict(result.exitCode);
}
