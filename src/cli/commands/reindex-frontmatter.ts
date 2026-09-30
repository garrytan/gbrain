/**
 * `gbrain reindex-frontmatter`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.29.1: recovery / explicit-rebuild path for pages.effective_date.
  // Mirror of reindex-code shape. Wraps the shared library function in
  // src/core/backfill-effective-date.ts (same code path the v0.29.1
  // migration orchestrator uses). The orchestrator runs once on
  // upgrade; this command is for after-the-fact frontmatter edits.
  //
  // v0.30.1: still works; canonical entrypoint is now `gbrain backfill
  // effective_date`. This command stays as a thin alias for back-compat.
  //
  // #1963: pass the already-connected engine. The command used to build
  // + connect its OWN engine here, which self-deadlocked on the PGLite
  // data-dir lock (this process already holds it via connectEngine
  // above) — 30s spin, then exit 1, on every PGLite invocation.
  const { reindexFrontmatterCli } = await import('../../commands/reindex-frontmatter.ts');
  await reindexFrontmatterCli(engine, args);
}
