/**
 * `foresights edge-proposals`: post-connect dispatch (relationship-contradiction
 * proposals from the edge_contradictions dream phase). The record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runEdgeProposals } = await import('../../commands/edge-proposals.ts');
  await runEdgeProposals(engine, args);
}
