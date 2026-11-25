/** `gbrain value`: post-connect dispatch (record in src/cli/command-table.ts, logic in src/commands/value.ts). */
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], ctx: CliDispatchContext): Promise<void> {
  const { runValue } = await import('../../commands/value.ts');
  await runValue(engine, args, ctx.makeContext!);
}
