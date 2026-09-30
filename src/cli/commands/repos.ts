/**
 * `gbrain repos`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.19.0: `gbrain repos ...` is an alias into the v0.18.0 sources
  // subsystem. The repos abstraction (Garry's OpenClaw baseline) was
  // redundant with sources and carried per-user config state that
  // couldn't participate in federation / RLS / multi-tenancy. We
  // keep the alias so scripts like `gbrain repos add .` keep
  // working, with a nudge toward the canonical command.
  console.error('[gbrain] Note: "repos" is an alias for "sources" as of v0.19.0. Prefer `gbrain sources <subcommand>`.');
  const { runSources } = await import('../../commands/sources.ts');
  await runSources(engine, args);
}
