/**
 * `gbrain watch`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.43 (#2095): push-based context transport. Blocks in the stdin
  // iteration (interactive stays alive; piped exits at EOF), then the
  // finally below runs finishCliTeardown (volunteer events drain with
  // every other sink) and the import.meta.main seam flush-exits.
  const { runWatch } = await import('../../commands/watch.ts');
  await runWatch(engine, args);
}
