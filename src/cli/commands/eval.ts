/**
 * `gbrain eval`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.32 EXP-5: `eval takes-quality {run,trend,regress}` requires a
  // brain (samples takes from DB / reads runs table). `replay` was
  // already routed through the no-DB bypass above and never reaches
  // this case. Other `eval` subcommands (export/prune/replay-capture/
  // longmemeval/cross-modal) go to the generic dispatcher.
  if (args[0] === 'takes-quality') {
    const { runEvalTakesQuality } = await import('../../commands/eval-takes-quality.ts');
    await runEvalTakesQuality(engine, args.slice(1));
    return;
  }
  const { runEvalCommand } = await import('../../commands/eval.ts');
  await runEvalCommand(engine, args);
}
