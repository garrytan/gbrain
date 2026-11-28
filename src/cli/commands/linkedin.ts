/**
 * `gbrain linkedin`: post-connect dispatch; implementation lives in src/commands/linkedin.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], _ctx: CliDispatchContext): Promise<void> {
  const { runLinkedIn } = await import('../../commands/linkedin.ts');
  await runLinkedIn(engine, args);
}
