/**
 * `gbrain policy`: post-connect dispatch (the owner's agent policy, L1). The record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runPolicy } = await import('../../commands/policy.ts');
  await runPolicy(engine, args);
}
