/**
 * `gbrain claw-test`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

export async function run(args: string[]): Promise<void> {
  const { runClawTest } = await import('../../commands/claw-test.ts');
  setCliExitVerdict(await runClawTest(args));
}
