/**
 * `gbrain recall`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.31: hot memory recall surface — `gbrain recall <entity>`,
  // `--since DUR`, `--session ID`, `--today`, `--grep TEXT`,
  // `--supersessions`, `--include-expired`, `--as-context`, `--json`.
  const { runRecall } = await import('../../commands/recall.ts');
  await runRecall(engine, args);
}
