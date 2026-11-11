/**
 * `gbrain memory-proposals`: post-connect dispatch (the owner's review of QM's proposed writes, GST-1158). The record
 * lives in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runMemoryProposals } = await import('../../commands/memory-proposals.ts');
  await runMemoryProposals(engine, args);
}
