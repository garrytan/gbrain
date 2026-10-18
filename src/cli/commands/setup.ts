/**
 * `gbrain setup <harness>`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator; the record lives in
 * src/cli/command-table.ts. Setup never opens the database itself: a new
 * brain is created by the `gbrain init` child it runs.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

export async function run(args: string[]): Promise<void> {
  const { runSetup } = await import('../../commands/setup.ts');
  setCliExitVerdict(await runSetup(args));
}
