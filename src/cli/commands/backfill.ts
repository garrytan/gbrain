/**
 * `gbrain backfill`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.30.1: first-class generic backfill command. Subcommand dispatch
  // is inside runBackfillCommand (kind | list | --help).
  // #1963: same double-connect class as reindex-frontmatter — reuse the
  // connected engine instead of building a second one on the same
  // PGLite data dir.
  const { runBackfillCommand } = await import('../../commands/backfill.ts');
  await runBackfillCommand(engine, args);
}
