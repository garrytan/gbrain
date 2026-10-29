/**
 * `gbrain git`: pre-connect dispatch. Every subcommand is engine-free and DB-free except `git maintenance --source`,
 * which opens the brain through `ctx.connectEngine` to find the source's checkout. The record lives in
 * src/cli/command-table.ts; the behavior in src/commands/git.ts (#6530).
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const { runGit } = await import('../../commands/git.ts');
  setCliExitVerdict(await runGit(args, () => ctx.connectEngine()));
}
