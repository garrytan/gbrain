/**
 * `gbrain pages`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.26.5: page-level operator commands (purge-deleted escape hatch).
  const { runPages } = await import('../../commands/pages.ts');
  await runPages(engine, args);
}
