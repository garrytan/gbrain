/**
 * `gbrain whatsapp`: post-connect dispatch; implementation lives in src/commands/whatsapp.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], _ctx: CliDispatchContext): Promise<void> {
  const { runWhatsApp } = await import('../../commands/whatsapp.ts');
  await runWhatsApp(engine, args);
}
