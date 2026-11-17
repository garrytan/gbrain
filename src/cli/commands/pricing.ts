/**
 * `foresights pricing`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. The record lives in src/cli/command-table.ts;
 * the behavior lives in src/commands/pricing.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runPricing } = await import('../../commands/pricing.ts');
  await runPricing(engine, args);
}
