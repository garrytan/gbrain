/**
 * `gbrain reindex-search-vector`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // Explicit recreate of FTS trigger functions + batched backfill,
  // honoring GBRAIN_FTS_LANGUAGE. Use after changing the language
  // env var on a brain that already ran the configurable_fts_language
  // migration.
  const { runReindexSearchVectorCli } = await import('../../commands/reindex-search-vector.ts');
  await runReindexSearchVectorCli(engine, args);
}
