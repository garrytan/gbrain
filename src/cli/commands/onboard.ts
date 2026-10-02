/**
 * `gbrain onboard`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.41.18.0 (T13) — gbrain onboard. Thin shell over T2 library
  // + T4 onboard checks + T12 render layer.
  const { runOnboard } = await import('../../commands/onboard.ts');
  await runOnboard(engine, args);
}
