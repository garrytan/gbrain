/**
 * `gbrain propose`: post-connect dispatch (record in src/cli/command-table.ts; behavior in src/commands/propose.ts).
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runPropose } = await import('../../commands/propose.ts');
  await runPropose(engine, args);
}
