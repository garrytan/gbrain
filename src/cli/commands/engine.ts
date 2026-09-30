/**
 * `gbrain engine`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

// db-availability loop (engine-free by design — these must work when the
// DB is down; that is the point).
export async function run(args: string[]): Promise<void> {
  const { runEngineStatus } = await import('../../commands/engine-status.ts');
  setCliExitVerdict(await runEngineStatus(args));
}
