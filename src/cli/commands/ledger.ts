/**
 * `gbrain ledger`: post-connect dispatch (the action ledger, L2). The record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runLedger } = await import('../../commands/ledger.ts');
  await runLedger(engine, args);
}
