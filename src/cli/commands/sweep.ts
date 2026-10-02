/**
 * `gbrain sweep`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // [CX2-5] Trusted local sweep entry — succeeds precisely because no
  // live serve holds the PGLite lock (connectEngine acquired it above).
  const { runSweep } = await import('../../commands/sweep.ts');
  await runSweep(engine, args);
}
