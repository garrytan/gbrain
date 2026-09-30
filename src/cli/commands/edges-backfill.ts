/**
 * `gbrain edges-backfill`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.34 W6 — operator escape hatch for the symbol-resolution backfill.
  // Resumable via the edges_backfilled_at watermark; per-batch transactions
  // commit so Ctrl-C leaves a clean resumable state.
  const { runEdgesBackfill } = await import('../../commands/edges-backfill.ts');
  await runEdgesBackfill(engine, args);
}
