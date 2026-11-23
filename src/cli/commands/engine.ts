/**
 * `gbrain engine`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

// db-availability loop (engine-free by design — these must work when the
// DB is down; that is the point).
export async function run(args: string[]): Promise<void> {
  if (args[0] === 'shadow') {
    const { runEngineShadow } = await import('../../commands/engine-shadow.ts');
    setCliExitVerdict(await runEngineShadow(args.slice(1)));
    return;
  }
  if (args[0] === 'swap') {
    // The read-only swap plan opens the brain itself (no migration) and writes nothing (S5a).
    const { runEngineSwap } = await import('../../commands/engine-swap.ts');
    setCliExitVerdict(await runEngineSwap(args.slice(1)));
    return;
  }
  const { runEngineStatus } = await import('../../commands/engine-status.ts');
  setCliExitVerdict(await runEngineStatus(args));
}
