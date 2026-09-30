/**
 * `gbrain conversation-parser`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

// v0.38 — Capture: single human-facing entrypoint for ingestion.
export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.41.13.0 — debug + introspection CLI for the new parser
  // cathedral. `scan <slug>` requires a connected brain; the
  // other subcommands are pure (`list-builtins`, `validate`).
  const { runConversationParser } = await import('../../commands/conversation-parser.ts');
  await runConversationParser(engine, args);
}
