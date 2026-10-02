/**
 * `gbrain embed`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], ctx: CliDispatchContext): Promise<void> {
  const { SELECTED_CONFIG_BY_ENGINE } = ctx;
  const { runEmbed } = await import('../../commands/embed.ts');
  // #3037: mirror the `import` case above — the CLI was discarding the
  // result, so a run where every chunk failed to embed still exited 0
  // and cron/CI/health gates read total silence as success. Surface
  // non-zero on failures > 0. (undefined = backgrounded via --background.)
  const embedResult = await runEmbed(engine, args, SELECTED_CONFIG_BY_ENGINE.get(engine) ?? null);
  if (embedResult && embedResult.failures > 0) {
    setCliExitVerdict(1);
  }
}
