/**
 * `gbrain code-callers`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.20.0 Cathedral II Layer 10 (C4): "who calls <symbol>?"
  const { runCodeCallers } = await import('../../commands/code-callers.ts');
  await runCodeCallers(engine, args);
}
