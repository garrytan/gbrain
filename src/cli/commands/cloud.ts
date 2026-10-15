/**
 * `gbrain cloud`: post-connect dispatch to commands/cloud.ts; the record
 * lives in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runCloud } = await import('../../commands/cloud.ts');
  await runCloud(engine, args);
}
