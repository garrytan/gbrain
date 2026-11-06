/**
 * `gbrain reindex --synopsis` (#8744): the explicit, operator-run per-chunk
 * synopsis sweep for pages whose configured contextual-retrieval tier is
 * per_chunk_synopsis (search.mode tokenmax, or a source or page override).
 * Import and sync embed those pages at the free title tier and nothing else
 * schedules the synopsis tier, so this command is how it gets applied.
 *
 * Without `--yes` it previews and spends nothing: the pages and chunks still
 * on the title tier, and the token and dollar ceiling on the configured
 * synopsis model plus the re-embed. With `--yes` it queues one
 * `contextual_reindex_per_chunk` job per page (the existing job and handler),
 * all under one spend authorization whose cap (`--max-usd`, else the derived
 * cap) the worker enforces across every job, then drains them in this process.
 * It is resumable: pages already stamped per_chunk_synopsis are never
 * selected again, and a job left queued or running by an interrupted run is
 * picked up again through its idempotency key (page, source and text revision).
 * Database reads and writes only, so a repo-less brain works the same way.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import type { MinionJob } from '../core/minions/types.ts';
import {
  SYNOPSIS_SWEEP_ARGV,
  SYNOPSIS_SWEEP_JOB,
  formatSynopsisCoverageLine,
  planSynopsisSweep,
  readSynopsisCoverage,
  type SynopsisCoverage,
  type SynopsisSweepPlan,
} from '../core/synopsis-sweep.ts';

const TERMINAL = new Set(['completed', 'failed', 'dead', 'cancelled']);

export interface SynopsisSweepRun {
  group_id: string;
  cap_usd: number | null;
  job_ids: number[];
  /** Pages whose job at their current text revision already finished in an earlier run (not queued again). */
  already_attempted: number;
  synopsis: number;
  title: number;
  skipped: number;
  failed: number;
}

export interface ReindexSynopsisResult {
  mode: 'not_applicable' | 'preview' | 'run';
  reason?: string;
  plan?: SynopsisSweepPlan;
  coverage?: SynopsisCoverage;
  run?: SynopsisSweepRun;
  coverage_after?: SynopsisCoverage;
}

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

function usd(value: number | null): string {
  return value === null ? 'unknown (no price for this model)' : `$${value.toFixed(2)}`;
}

function planJson(plan: SynopsisSweepPlan) {
  const { pages, config, ...rest } = plan;
  return { ...rest, global_tier: config.global_tier, synopsis_sources: config.synopsis_sources, pages: pages.length };
}

export async function runReindexSynopsis(engine: BrainEngine, args: string[], opts: { pollMs?: number } = {}): Promise<ReindexSynopsisResult> {
  const json = args.includes('--json');
  const say = (line: string) => { if (!json) console.log(line); };
  const emit = (result: ReindexSynopsisResult) => {
    if (json) {
      process.stdout.write(JSON.stringify({
        mode: result.mode,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.plan ? { plan: planJson(result.plan) } : {}),
        ...(result.coverage ? { coverage: { ...result.coverage, config: undefined } } : {}),
        ...(result.run ? { run: result.run } : {}),
        ...(result.coverage_after ? { coverage_after: { ...result.coverage_after, config: undefined } } : {}),
        run_argv: [...SYNOPSIS_SWEEP_ARGV, '--yes'],
      }, null, 2) + '\n');
    }
    return result;
  };

  const limitRaw = flagValue(args, '--limit');
  const sourceId = flagValue(args, '--source');
  if ((args.includes('--limit') && !(limitRaw && /^\d+$/.test(limitRaw) && Number(limitRaw) > 0))
    || (args.includes('--source') && (!sourceId || sourceId.startsWith('--')))) {
    const error = args.includes('--limit') && !(limitRaw && /^\d+$/.test(limitRaw)) ? 'invalid --limit: expected a positive integer' : 'invalid --source: expected a value';
    if (json) process.stdout.write(JSON.stringify({ error }) + '\n');
    else process.stderr.write(`[reindex --synopsis] ${error}\n`);
    setCliExitVerdict(2);
    return { mode: 'not_applicable', reason: error };
  }

  const { embeddingsDisabled } = await import('../core/embedding-disabled.ts');
  if (await embeddingsDisabled(engine)) {
    const reason = 'Embeddings are disabled on this brain (keyless by choice), so there are no vectors to put on the synopsis tier; keyword search keeps working.';
    say(`[reindex --synopsis] Nothing to do. ${reason}`);
    return emit({ mode: 'not_applicable', reason });
  }

  const { resolveContextualSynopsisModel } = await import('../core/minions/handlers/contextual-reindex-per-chunk.ts');
  const { resolveSynopsisMaxTokens } = await import('../core/contextual-retrieval-service.ts');
  const synopsisModel = await resolveContextualSynopsisModel(engine);
  let embeddingPricePerMTok: number | null = null;
  let embeddingModel = 'unknown';
  try {
    const { getEmbeddingModel } = await import('../core/ai/gateway.ts');
    const { lookupEmbeddingPrice } = await import('../core/embedding-pricing.ts');
    embeddingModel = getEmbeddingModel();
    const price = lookupEmbeddingPrice(embeddingModel);
    if (price.kind === 'known') embeddingPricePerMTok = price.pricePerMTok;
  } catch { /* no configured embedding model: the embedding share stays unknown */ }

  const plan = await planSynopsisSweep(engine, {
    synopsisModel,
    synopsisMaxTokens: await resolveSynopsisMaxTokens(engine),
    ...(sourceId ? { sourceId } : {}),
    ...(limitRaw ? { limit: Number(limitRaw) } : {}),
    embeddingPricePerMTok,
  });
  if (!plan.config.configured) {
    const reason = `The configured contextual-retrieval tier is ${plan.config.kill_switch ? 'off (kill switch)' : plan.config.global_tier}, not per_chunk_synopsis, so no page needs the synopsis sweep. `
      + 'search.mode tokenmax (or search.contextual_retrieval per_chunk_synopsis, or gbrain sources set-cr-mode <id> per_chunk_synopsis) selects it.';
    say(`[reindex --synopsis] Nothing to do. ${reason}`);
    return emit({ mode: 'not_applicable', reason, plan });
  }
  const coverage = await readSynopsisCoverage(engine, { config: plan.config, ...(sourceId ? { sourceIds: [sourceId] } : {}) });
  const tierSource = plan.config.global_tier === 'per_chunk_synopsis' ? 'search mode' : `source override (${plan.config.synopsis_sources.join(', ')})`;
  say(`[reindex --synopsis] Configured tier: per_chunk_synopsis (${tierSource}).`);
  say(`  ${formatSynopsisCoverageLine(coverage)}`);
  if (plan.pages.length === 0) {
    say('  Nothing to sweep: every eligible page is already on the synopsis tier.');
    return emit({ mode: 'preview', plan, coverage });
  }
  say(`  The sweep would synopsize ${plan.pages.length} page(s), ${plan.chunks} chunk(s), on ${synopsisModel}:`);
  say(`    synopsis input tokens   up to ${plan.est_input_tokens} (every prompt uncached; the prompt cache usually serves most)`);
  say(`    synopsis output tokens  up to ${plan.est_output_tokens} (the output cap per chunk)`);
  say(`    synopsis cost           up to ${usd(plan.est_synopsis_usd)}`);
  say(`    re-embed cost           about ${usd(plan.est_embedding_usd)} (${embeddingModel})`);
  say(`    total                   up to ${usd(plan.est_usd)}`);
  if (plan.remaining_pages > 0) say(`  ${plan.remaining_pages} more pending page(s) are beyond --limit; a later run picks them up.`);

  if (!args.includes('--yes')) {
    say(`  Preview only; nothing was queued or spent. Run it (paid, resumable): ${[...SYNOPSIS_SWEEP_ARGV, ...(sourceId ? ['--source', sourceId] : []), ...(limitRaw ? ['--limit', limitRaw] : []), '--yes'].join(' ')} [--max-usd <usd>]`);
    return emit({ mode: 'preview', plan, coverage });
  }

  const { requireConsent } = await import('../core/consent.ts');
  const { engineConsentEnv } = await import('../core/consent-cli.ts');
  const { jobSpendAuthorization, spendSubmitSummary } = await import('../core/minions/spend-authorization.ts');
  const argv = ['gbrain', 'reindex', ...args.filter(a => a !== '--yes' && a !== '--json')];
  const previewArgv = argv.filter((a, i) => a !== '--max-usd' && argv[i - 1] !== '--max-usd' && !a.startsWith('--max-usd='));
  const auth = await requireConsent({
    command: 'reindex --synopsis', effects: ['paid'], actor: 'agent',
    what: `Write per-chunk synopses for ${plan.pages.length} page(s) (${plan.chunks} chunk(s)) and re-embed them`,
    why: `The configured contextual-retrieval tier is per_chunk_synopsis, but these pages search on title-tier vectors until the sweep runs. Each chunk costs one ${synopsisModel} call plus its re-embed (up to ${usd(plan.est_usd)}).`,
    risk: 'Spends money with the chat and embedding providers. Search keeps working on the current vectors while it runs; a page whose synopsis is refused stays on the title tier.',
    user_message: `Put ${plan.pages.length} page(s) on the per-chunk synopsis tier for up to ${usd(plan.est_usd)}?`,
    argv, preview_argv: previewArgv,
    est_usd: plan.est_usd, args,
  }, engineConsentEnv(engine));
  const spend = jobSpendAuthorization(auth, { command: 'reindex --synopsis', of: plan.pages.length, argv, ...(plan.est_usd !== null ? { est_usd: plan.est_usd } : {}) });
  if (spend.cap_usd !== null && plan.est_usd !== null && plan.est_usd > spend.cap_usd) {
    say(`  The $${spend.cap_usd.toFixed(2)} cap is below the ${usd(plan.est_usd)} ceiling, so the run may stop part-way; run the same command again (with a higher --max-usd) to continue.`);
  }

  const { MinionQueue } = await import('../core/minions/queue.ts');
  const queue = new MinionQueue(engine);
  await queue.ensureSchema();
  const jobs: MinionJob[] = [];
  for (const page of plan.pages) {
    jobs.push(await queue.add(SYNOPSIS_SWEEP_JOB, { page_slug: page.slug, expected_source_id: page.source_id },
      { idempotency_key: `${SYNOPSIS_SWEEP_JOB}:${page.source_id}:${page.slug}:${page.revision ?? 'unrevised'}` },
      { allowProtectedSubmit: true, spendAuthorization: spend }));
  }
  for (const line of spendSubmitSummary(spend, jobs, argv).lines) say(`  ${line}`);
  const alreadyAttempted = jobs.filter(j => TERMINAL.has(j.status)).length;
  const pendingIds = jobs.filter(j => !TERMINAL.has(j.status)).map(j => j.id);
  if (alreadyAttempted) say(`  ${alreadyAttempted} page(s) already had a finished sweep job at their current revision; they are not queued again until the page changes.`);

  if (pendingIds.length) {
    say(`  Running ${pendingIds.length} job(s) in this process...`);
    const { MinionWorker } = await import('../core/minions/worker.ts');
    const { makeContextualReindexHandler } = await import('../core/minions/handlers/contextual-reindex-per-chunk.ts');
    const pollMs = opts.pollMs ?? 500;
    const worker = new MinionWorker(engine, { pollInterval: pollMs, healthCheckInterval: 0 });
    worker.register(SYNOPSIS_SWEEP_JOB, makeContextualReindexHandler({ engine }));
    const running = worker.start();
    let settled = false;
    const watch = (async () => {
      while (!settled) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        const rows = await engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id = ANY($1::int[])', [pendingIds]);
        if (rows.every(r => TERMINAL.has(r.status))) { settled = true; worker.stop(); }
      }
    })();
    await running;
    settled = true;
    await watch.catch(() => undefined);
    if (worker.configurationError) {
      const { reportInlineWorkerConfiguration } = await import('./jobs-readiness.ts');
      reportInlineWorkerConfiguration(worker.configurationError);
    }
  }

  const finished = await engine.executeRaw<{ id: number | string; status: string; result: unknown; error_text: string | null }>(
    'SELECT id, status, result, error_text FROM minion_jobs WHERE id = ANY($1::int[])', [jobs.map(j => j.id)]);
  const run: SynopsisSweepRun = { group_id: spend.group_id, cap_usd: spend.cap_usd, job_ids: jobs.map(j => j.id), already_attempted: alreadyAttempted,
    synopsis: 0, title: 0, skipped: 0, failed: 0 };
  for (const row of finished) {
    const result = (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as { mode_applied?: string } | null;
    if (row.status !== 'completed') { run.failed++; continue; }
    if (result?.mode_applied === 'per_chunk_synopsis') run.synopsis++;
    else if (result?.mode_applied === 'skipped') run.skipped++;
    else run.title++;
  }
  const coverageAfter = await readSynopsisCoverage(engine, { config: plan.config, ...(sourceId ? { sourceIds: [sourceId] } : {}) });
  say(`  Done: ${run.synopsis} page(s) on the synopsis tier, ${run.title} on the title tier (synopsis refused), ${run.skipped} skipped, ${run.failed} failed.`);
  if (run.failed) say(`  Failed jobs keep their reason: gbrain jobs list --status dead. Run the same command again to resume.`);
  say(`  ${formatSynopsisCoverageLine(coverageAfter)}`);
  if (run.failed) setCliExitVerdict(1);
  return emit({ mode: 'run', plan, coverage, run, coverage_after: coverageAfter });
}
