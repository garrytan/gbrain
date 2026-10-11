/**
 * `gbrain questions`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened; the record lives in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runQuestions } = await import('../../commands/questions.ts');
  await runQuestions(engine, args);
}
