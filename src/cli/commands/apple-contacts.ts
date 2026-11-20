/**
 * `gbrain apple-contacts`: post-connect dispatch; the implementation is src/commands/apple-contacts.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], _ctx: CliDispatchContext): Promise<void> {
  const { runAppleContacts } = await import('../../commands/apple-contacts.ts');
  await runAppleContacts(engine, args);
}
