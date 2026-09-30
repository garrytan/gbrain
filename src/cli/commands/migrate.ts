/**
 * `gbrain migrate`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

// doctor is handled before connectEngine() above
export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // #3390: `gbrain migrate embeddings --to <provider:model>` — the
  // provider-agnostic embedding migration. Everything else stays the
  // engine-transfer path (`migrate --to <supabase|pglite>`).
  if (args[0] === 'embeddings') {
    const { runMigrateEmbeddings } = await import('../../commands/migrate-embeddings.ts');
    await runMigrateEmbeddings(engine, args.slice(1));
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain migrate --to <supabase|pglite> [--url <url>] [--path <path>] [--force]');
    console.log('       gbrain migrate embeddings --to <provider:model> [--dim N] [--dry-run] [--yes]');
    console.log('');
    console.log('The first form transfers the brain between engines; the second re-embeds');
    console.log('onto a different embedding provider (run `gbrain migrate embeddings --help`).');
    return;
  }
  const { runMigrateEngine } = await import('../../commands/migrate-engine.ts');
  await runMigrateEngine(engine, args);
}
