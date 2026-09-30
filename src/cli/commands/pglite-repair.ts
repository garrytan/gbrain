/**
 * `gbrain pglite-repair`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

// WAL-repair wave (#223/#1670/#2575): in-place torn-WAL recovery. Never
// connects an engine — the whole point is that the DB won't open.
export async function run(args: string[]): Promise<void> {
  const { runPgliteRepair } = await import('../../commands/pglite-repair.ts');
  setCliExitVerdict(await runPgliteRepair(args));
}
