/**
 * `gbrain dedupe`: post-connect dispatch, run by handleCliOnly with the engine connectEngine() opened; the record
 * lives in src/cli/command-table.ts and the behavior in src/commands/dedupe.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runDedupe } = await import('../../commands/dedupe.ts');
  await runDedupe(engine, args);
}
