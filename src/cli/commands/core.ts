/**
 * `gbrain core`: post-connect dispatch for always-loaded core memory; the
 * record lives in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runCore } = await import('../../commands/core.ts');
  await runCore(engine, args);
}
