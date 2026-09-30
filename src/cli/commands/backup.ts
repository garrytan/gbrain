/**
 * `gbrain backup`: pre-connect dispatch (opens its own engine), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const { connectEngine } = ctx;
  // Monthly backup-coverage check. Engine via thunk: a serve-held PGLite
  // lock degrades to the cached verdict inside runBackupCli instead of a
  // connectEngine crash (the primary cohort runs a long-lived stdio serve).
  const { runBackupCli } = await import('../../commands/backup.ts');
  setCliExitVerdict((await runBackupCli(args, () => connectEngine())).exitCode);
}
