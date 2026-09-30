/**
 * `gbrain compile-context`: pre-connect dispatch (opens its own engine), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { finishCliTeardown, setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const { connectEngine } = ctx;
  const { runCompileContext } = await import('../../commands/compile-context.ts');
  const eng = await connectEngine();
  try {
    setCliExitVerdict(await runCompileContext(eng, args));
  } finally {
    await finishCliTeardown({ engine: eng });
  }
}
