/**
 * `gbrain advisor`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

// v0.43 (#2180) — `gbrain advisor`: ranked, read-only "what to do next".
// CLI surface; the same signals are exposed over MCP via the `advisor` op.
export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runAdvisorCli } = await import('../../commands/advisor.ts');
  const result = await runAdvisorCli(engine, args);
  process.exit(result.exitCode);
}
