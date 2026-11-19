/**
 * `foresights migrate`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

// doctor is handled before connectEngine() above
export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // #3390: `foresights migrate embeddings --to <provider:model>` — the
  // provider-agnostic embedding migration. Everything else stays the
  // engine-transfer path (`migrate --to <postgres|supabase|pglite>`; PGLite -> Postgres
  // graduation is routed before connect in src/cli.ts).
  if (args[0] === 'embeddings') {
    const { runMigrateEmbeddings } = await import('../../commands/migrate-embeddings.ts');
    await runMigrateEmbeddings(engine, args.slice(1));
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    const { GRADUATION_USAGE } = await import('../../commands/migrate-graduation.ts');
    console.log(GRADUATION_USAGE);
    console.log('       foresights migrate --to pglite [--path <path>] [--force]');
    console.log('       foresights migrate embeddings --to <provider:model> [--dim N] [--dry-run] [--yes]');
    console.log('');
    console.log('PGLite -> Postgres graduates the brain: without --yes it prints the plan and exits 3;');
    console.log('the run (--yes --expect <plan_hash>) copies every table, verifies it, and only then');
    console.log('switches engines. --to supabase is an alias of --to postgres. Postgres -> PGLite uses');
    console.log('the legacy copier. `foresights config set migrate.graduation false` opts out of graduation.');
    console.log('Guide: docs/guides/move-to-postgres.md. The last form re-embeds onto a different');
    console.log('embedding provider (run `foresights migrate embeddings --help`).');
    return;
  }
  const { runMigrateEngine } = await import('../../commands/migrate-engine.ts');
  await runMigrateEngine(engine, args);
}
