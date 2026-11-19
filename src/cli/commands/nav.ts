/**
 * `foresights nav`: post-connect dispatch, run by handleCliOnly with the engine
 * connectEngine() opened. The record lives in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runNav } = await import('../../commands/nav.ts');
  await runNav(engine, args);
}
