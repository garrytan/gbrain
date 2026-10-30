/**
 * `gbrain serve`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // #7246: rotate and dedupe serve's own log when its stdout/stderr is a file.
  (await import('../../core/serve-log.ts')).installServeLogSink({ http: args.includes('--http') });
  const { runServe } = await import('../../commands/serve.ts');
  await runServe(engine, args);
  // serve doesn't disconnect
}
