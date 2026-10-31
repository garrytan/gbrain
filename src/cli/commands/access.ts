/**
 * `gbrain access` (GBRA-218): post-connect dispatch with the engine
 * connectEngine() opened; the record lives in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runAccess } = await import('../../commands/access.ts');
  await runAccess(engine, args);
}
