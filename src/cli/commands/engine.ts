/**
 * `gbrain engine`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { ShadowStatus } from '../../core/engine-swap/readiness.ts';

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
    // The swap reads the same status document `gbrain engine shadow status --json` prints (one builder).
    const { runEngineSwap } = await import('../../commands/engine-swap.ts');
    const { readConfiguredShadowStatus } = await import('../../shadow/status-document.ts');
    const { loadConfig } = await import('../../core/config.ts');
    setCliExitVerdict(await runEngineSwap(args.slice(1), {
      // The swap passes the primary it already holds open, so eligibility's one read-only SELECT needs no new connection.
      readShadowStatus: async (engine) => (await readConfiguredShadowStatus(() => loadConfig(), new Date(), engine)) as ShadowStatus | null,
    }));
    return;
  }
  const { runEngineStatus } = await import('../../commands/engine-status.ts');
  setCliExitVerdict(await runEngineStatus(args));
}
