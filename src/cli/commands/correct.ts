/**
 * `gbrain correct`: post-connect dispatch, run by handleCliOnly with the engine connectEngine() opened. The record
 * lives in src/cli/command-table.ts; the body in src/commands/correct.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runCorrectCli } = await import('../../commands/correct.ts');
  await runCorrectCli(engine, args);
}
