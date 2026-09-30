/**
 * `gbrain hook`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

export async function run(args: string[]): Promise<void> {
  // `gbrain hook <event>` — harness hook entry (plan D5): NEVER opens an
  // engine (talks to serve's IPC socket only); fail-open exit-0 contract
  // lives inside runHook.
  const { runHook } = await import('../../commands/hook.ts');
  setCliExitVerdict(await runHook(args));
}
