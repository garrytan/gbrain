/**
 * `gbrain profile`: post-connect dispatch (lane 3 P1); the record lives in src/cli/command-table.ts. Thin clients run it
 * engine-free (src/cli/main.ts), routed to the remote context_pack inside the command file. `profile import` writes
 * through the CLI's own trusted-local context (makeContext), so its remember batches are the user's interactive writes.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], ctx?: CliDispatchContext): Promise<void> {
  const { runProfile } = await import('../../commands/profile.ts');
  await runProfile(engine, args, ctx?.makeContext);
}
