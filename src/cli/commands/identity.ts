/**
 * `gbrain identity`: post-connect dispatch, run by handleCliOnly with the engine connectEngine() opened; the record lives
 * in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runIdentity } = await import('../../commands/identity.ts');
  await runIdentity(engine, args);
}
