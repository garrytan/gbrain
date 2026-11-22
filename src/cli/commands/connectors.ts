/**
 * `gbrain connectors`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], ctx: CliDispatchContext): Promise<void> {
  const { runConnectors } = await import('../../commands/connectors/index.ts');
  await runConnectors(engine, args, { makeContext: ctx.makeContext });
}
