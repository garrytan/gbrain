/**
 * `gbrain extract-conversation-facts`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runExtractConversationFacts } = await import('../../commands/extract-conversation-facts.ts');
  await runExtractConversationFacts(engine, args);
}
