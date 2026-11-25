/**
 * `gbrain rules`: post-connect dispatch, run by handleCliOnly with the engine connectEngine() opened. The record
 * lives in src/cli/command-table.ts; the body in src/commands/rules.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runRules } = await import('../../commands/rules.ts');
  await runRules(engine, args);
}
