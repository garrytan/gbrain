/**
 * `gbrain household`: post-connect dispatch, run by handleCliOnly with the engine connectEngine() opened; the record
 * lives in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runHousehold } = await import('../../commands/household.ts');
  await runHousehold(engine, args);
}
