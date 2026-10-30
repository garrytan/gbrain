/** `gbrain diag`: post-connect dispatch (record in src/cli/command-table.ts, logic in src/commands/diag.ts). */
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], ctx: CliDispatchContext): Promise<void> {
  const { runDiag } = await import('../../commands/diag.ts');
  await runDiag(engine, args, ctx.makeContext);
}
