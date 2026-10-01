/**
 * `gbrain whoknows`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.33 (Issue #?): expertise + relationship-proximity routing.
  // MCP op `find_experts` (read-scoped) backs the same code path; CLI
  // dispatch here is the user-facing surface. Thin-client routing
  // happens inside runWhoknows via isThinClient(cfg) (v0.31.1 pattern).
  const { runWhoknows } = await import('../../commands/whoknows.ts');
  await runWhoknows(engine, args);
}
