/**
 * `gbrain brainstorm`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.37.0 (Open Collider wave): bisociation idea generator grounded
  // in the user's own brain. Prefix-stratified domain-bank (D14) +
  // shared judges + citation transparency (D6). LSD MCP exposure
  // deferred to D7; this is CLI-only.
  const { runBrainstormCommand } = await import('../../commands/brainstorm.ts');
  await runBrainstormCommand(engine, args);
}
