/**
 * `gbrain git`: pre-connect dispatch (engine-free, DB-free). The record lives
 * in src/cli/command-table.ts; the behavior in src/commands/git.ts (#6530).
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

export async function run(args: string[]): Promise<void> {
  const { runGit } = await import('../../commands/git.ts');
  setCliExitVerdict(await runGit(args));
}
