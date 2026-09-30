/**
 * `gbrain founder`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.35.4 (T7) — founder scorecard. `gbrain founder scorecard <slug>`
  // rolls up Phase 2's typed-claim substrate into the four scorecard
  // metrics (claim accuracy, consistency, growth trajectory, red flags).
  // Thin-client routing handled inside the command file.
  const { runFounder } = await import('../../commands/founder-scorecard.ts');
  await runFounder(engine, args);
}
