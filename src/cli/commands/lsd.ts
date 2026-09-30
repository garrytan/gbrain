/**
 * `gbrain lsd`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.37.0 — Lateral Synaptic Drift. Inverted-judge / stale-bias
  // variant of brainstorm. Shares the orchestrator + judges via
  // LSD_PROFILE config. Local-only by design (cost + weirdness gate).
  const { runLsdCommand } = await import('../../commands/lsd.ts');
  await runLsdCommand(engine, args);
}
