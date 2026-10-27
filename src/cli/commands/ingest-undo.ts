/**
 * `gbrain ingest-undo`: post-connect dispatch, run by handleCliOnly with the engine connectEngine() opened; the record
 * lives in src/cli/command-table.ts and the body in src/commands/ingest.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runIngestUndoCli } = await import('../../commands/ingest.ts');
  await runIngestUndoCli(engine, args);
}
