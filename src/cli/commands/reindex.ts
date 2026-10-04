/**
 * `gbrain reindex`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { usageError, writeCliError } from '../cli-error.ts';
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const reindex = await import('../../commands/reindex.ts'); args = reindex.normalizeReindexArgs(args);
  const scopeError = reindex.validateReindexModeScope(args);
  // Agent contract v1 D1/D4: a scope/value error is a usage error (exit 2) rendered by renderCliError;
  // the --limit refusal keeps its legacy `--json` key (`error: "invalid --limit: …"`).
  if (scopeError) {
    const legacy = scopeError.startsWith('invalid --limit') ? { legacy: { error: scopeError } } : {};
    setCliExitVerdict(writeCliError(usageError(`[reindex] ${scopeError}`, 'Run `gbrain reindex --help` for the modes and their flags, e.g. gbrain reindex --multimodal --limit 100.'), 'reindex', legacy));
    return;
  }
  if (args.includes('--multimodal')) {
    const { runReindexMultimodal } = await import('../../commands/reindex-multimodal.ts');
    const { parseWorkers } = await import('../../core/sync-concurrency.ts');
    const limitIdx = args.indexOf('--limit');
    const limitVal = limitIdx >= 0 && limitIdx + 1 < args.length ? parseInt(args[limitIdx + 1], 10) : undefined;
    // v0.41.15.0 (T9, D9): --workers N for parallel UPDATEs within
    // each Voyage batch. Honored by the inner write loop only;
    // the outer batch loop is one Voyage round-trip per batch.
    const workersIdx = args.indexOf('--workers');
    const concurrencyIdx = args.indexOf('--concurrency');
    const workersValIdx = workersIdx >= 0 ? workersIdx + 1 : (concurrencyIdx >= 0 ? concurrencyIdx + 1 : -1);
    const workers = workersValIdx > 0 && workersValIdx < args.length
      ? parseWorkers(args[workersValIdx])
      : undefined;
    const result = await runReindexMultimodal(engine, {
      limit: Number.isFinite(limitVal as number) ? (limitVal as number) : undefined,
      dryRun: args.includes('--dry-run'),
      costEstimate: args.includes('--cost-estimate'),
      noEmbed: args.includes('--no-embed'),
      json: args.includes('--json'),
      yes: args.includes('--yes'),
      workers,
    });
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`reindex --multimodal: ${result.reembedded} re-embedded, ${result.failed} failed, ${result.pending_after} pending. est. cost: $${result.cost_usd_estimate.toFixed(2)}`);
    }
    return;
  }
  if (args.includes('--vectors')) {
    await (await import('../../commands/reindex-vectors.ts')).runReindexVectors(engine, args); // #4616
    return;
  }
  if (args.includes('--aliases')) {
    // T8 — backfill the free-text alias layer (page_aliases) for existing
    // pages whose frontmatter `aliases:` predate the import-time projection.
    const { runReindexAliases } = await import('../../commands/reindex-aliases.ts');
    await runReindexAliases(engine, args);
    return;
  }
  const { runReindex } = await import('../../commands/reindex.ts');
  await runReindex(engine, args);
}
