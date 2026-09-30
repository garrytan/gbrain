/**
 * `gbrain reconcile-links`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.20.0 Cathedral II Layer 8 D3: batch-recompute doc↔impl edges
  // for any markdown page that cites code files. Idempotent; safe to
  // re-run. Closes the v0.19.0 Layer 6 order-dependency bug where
  // guides imported before their code never got their edges written.
  const { runReconcileLinksCli } = await import('../../commands/reconcile-links.ts');
  await runReconcileLinksCli(engine, args);
}
