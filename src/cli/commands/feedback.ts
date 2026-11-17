/**
 * `foresights feedback`: post-connect dispatch; the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runFeedback } = await import('../../commands/feedback.ts');
  await runFeedback(engine, args);
}
