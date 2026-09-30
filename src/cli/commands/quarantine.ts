/**
 * `gbrain quarantine`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.42 (#1699): content-quality gate operator surface.
  const { runQuarantine } = await import('../../commands/quarantine.ts');
  await runQuarantine(engine, args);
}
