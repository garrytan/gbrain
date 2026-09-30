/**
 * `gbrain friction`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

export async function run(args: string[]): Promise<void> {
  const { runFriction } = await import('../../commands/friction.ts');
  // #2084 inner-exit sweep: verdict + return so teardown + the flush seam run.
  setCliExitVerdict(runFriction(args));
}
