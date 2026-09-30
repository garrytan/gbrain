/**
 * `gbrain reindex-code`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.20.0 Cathedral II Layer 13 (E2): explicit code-page reindex
  // for users upgrading from v0.19.0. Cost-preview gated; TTY prompt
  // or ConfirmationRequired envelope for non-TTY/JSON callers.
  const { runReindexCodeCli } = await import('../../commands/reindex-code.ts');
  await runReindexCodeCli(engine, args);
}
