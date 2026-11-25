/**
 * `gbrain profile`: post-connect dispatch (lane 3 P1); the record lives in src/cli/command-table.ts. Thin clients run it
 * engine-free (src/cli/main.ts), routed to the remote context_pack inside the command file.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runProfile } = await import('../../commands/profile.ts');
  await runProfile(engine, args);
}
