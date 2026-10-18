/**
 * `gbrain beliefs`: post-connect dispatch for the belief ledger's coverage
 * tooling; the behavior lives in src/commands/beliefs.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runBeliefs } = await import('../../commands/beliefs.ts');
  await runBeliefs(engine, args);
}
