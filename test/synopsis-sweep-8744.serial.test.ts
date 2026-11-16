/**
 * #8744: with search.mode tokenmax (contextual retrieval per_chunk_synopsis),
 * import embeds pages at the title tier and nothing scheduled the synopsis
 * sweep, so a brain searched on title-tier vectors with no warning. Pins:
 *   - doctor synopsis_tier_coverage warns on a tokenmax brain with no
 *     synopsis vectors (coverage and the gbrain reindex --synopsis fix), and
 *     is not applicable on a balanced brain;
 *   - the preview's pages, chunks, tokens and dollars on the configured
 *     synopsis model, and that it queues and spends nothing;
 *   - switching to tokenmax on a TTY previews the sweep and asks before
 *     running `gbrain reindex --synopsis --yes`; a no queues nothing;
 *   - a --yes run under a cap below one synopsis call is refused by the
 *     shared spend group and stamps nothing; a later run resumes;
 *   - --yes queues one contextual_reindex_per_chunk job per page under one
 *     spend group and completes them in-process; the pages land on the
 *     synopsis tier, the check turns ok, and a rerun has nothing to sweep;
 *   - inline pages over the large-page threshold stay out of the sweep.
 * The brains here have no git repository (repo-less): the sweep reads and
 * writes the database only.
 *
 * Fake chat + embed transports (no provider is called). Serial: mutates the
 * process-global gateway, its transports and env vars. Runs on PGLite, and on
 * Postgres through test/e2e/synopsis-sweep-8744-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { checkSynopsisTierCoverage } from '../src/commands/doctor/checks/synopsis-coverage.ts';
import { runReindexSynopsis } from '../src/commands/reindex-synopsis.ts';
import { runModeSwitchUx } from '../src/core/search/mode-switch-ux.ts';
import { estimateSynopsisCallUsd, SYNOPSIS_MAX_TOKENS } from '../src/core/page-summary.ts';
import { reservationCostUsd } from '../src/core/budget/reservation-cost.ts';
import { lookupEmbeddingPrice } from '../src/core/embedding-pricing.ts';
import { buildModesReport, redactReadinessForRemote } from '../src/core/search/modes-report.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const DIMS = 1536;
const EMBED_MODEL = 'openai:text-embedding-3-large';
const SYNOPSIS_MODEL = 'anthropic:claude-haiku-4-5-20251001';
let chatCalls = 0;
let home: string;
const saved = { home: process.env.GBRAIN_HOME, model: process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL };

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-synopsis-sweep-'));
  process.env.GBRAIN_HOME = home;
  process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL = SYNOPSIS_MODEL;
  configureGateway({ embedding_model: EMBED_MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-fake', ANTHROPIC_API_KEY: 'sk-ant-test-fake' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) =>
    ({ embeddings: values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: 0 } })) as never);
  __setChatTransportForTests(async () => {
    chatCalls++;
    return { text: 'Synopsis: a note about the example topic.', blocks: [], stopReason: 'end',
      usage: { input_tokens: 500, output_tokens: 12, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: SYNOPSIS_MODEL, providerId: 'anthropic' } as never;
  });
});

afterAll(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  if (saved.home === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = saved.home;
  if (saved.model === undefined) delete process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL; else process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL = saved.model;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => { chatCalls = 0; _resetCliExitVerdictForTests(); });

const body = (title: string, paragraphs: number) => `---\ntype: note\ntitle: ${title}\n---\n\n${Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i} about ${title}. `.repeat(30)).join('\n\n')}\n`;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  const error = console.error;
  const write = process.stderr.write.bind(process.stderr);
  console.log = () => {};
  console.error = () => {};
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return await fn(); } finally { console.log = log; console.error = error; process.stderr.write = write; }
};

for (const kind of testBackends()) describe(`#8744 synopsis sweep (${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({ embedding_dimensions: DIMS } as never); await engine.initSchema(); }
    await engine.setConfig('search.mode', 'balanced');
    await importFromContent(engine, 'notes/alpha-example', body('Alpha example', 2), { sourceId: 'default' });
    await importFromContent(engine, 'notes/beta-example', body('Beta example', 6), { sourceId: 'default' });
    await importFromContent(engine, 'notes/large-example', body('Large example', 1), { sourceId: 'default' });
    // An inline page over the 1 MiB large-page threshold (legacy shape): the title tier by design.
    await engine.executeRaw(`UPDATE pages SET compiled_truth = repeat('x', 1100000) WHERE slug = 'notes/large-example'`);
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });

  const chunkStats = async (slug: string) => {
    const rows = await engine.executeRaw<{ chunk_text: string }>(
      `SELECT c.chunk_text
         FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1 AND c.chunk_source <> 'image_asset' ORDER BY c.chunk_index`, [slug]);
    return rows;
  };

  test('balanced brain: the check is not applicable and the command has nothing to do', async () => {
    const check = await checkSynopsisTierCoverage(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Not applicable');
    const result = await quiet(() => runReindexSynopsis(engine, ['--synopsis']));
    expect(result.mode).toBe('not_applicable');
  });

  test('tokenmax brain with no synopsis vectors: doctor warns with coverage and the preview command', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    const modes = await engine.executeRaw<{ mode: string | null }>(`SELECT contextual_retrieval_mode AS mode FROM pages ORDER BY slug`);
    expect(modes.every(m => m.mode !== 'per_chunk_synopsis')).toBe(true);
    const check = await checkSynopsisTierCoverage(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('0% of chunks');
    expect(check.message).toContain('gbrain reindex --synopsis');
    expect(check.message).toContain('No synopsis sweep job has ever run');
    expect(check.message).toContain('1 large page(s)');
    expect(check.details).toMatchObject({ coverage_pct: 0, synopsis_chunks: 0, eligible_pages: 2, large_title_pages: 1, sweep_jobs: 0 });
    expect(check.fix?.argv).toEqual(['gbrain', 'reindex', '--synopsis']);
    // The remote doctor's grant confines every count: a caller granted another source sees none of these pages.
    const scoped = await checkSynopsisTierCoverage(engine, { sourceIds: ['source-b'] });
    expect(scoped.details).toMatchObject({ eligible_chunks: 0, eligible_pages: 0, large_title_pages: 0 });
    expect(scoped.details).not.toHaveProperty('sweep_jobs');
    const report = await buildModesReport(engine);
    expect(report.synopsis_coverage).toMatchObject({ coverage_pct: 0, synopsis_chunks: 0, fix: 'gbrain reindex --synopsis' });
    expect(report.synopsis_coverage!.line).toContain('0% of chunks');
    expect(redactReadinessForRemote(report).synopsis_coverage).toBeUndefined();
  });

  test('preview: pages, chunks, tokens and dollars on the configured synopsis model; nothing queued', async () => {
    const result = await quiet(() => runReindexSynopsis(engine, ['--synopsis']));
    expect(result.mode).toBe('preview');
    const plan = result.plan!;
    expect(plan.synopsis_model).toBe(SYNOPSIS_MODEL);
    expect(plan.pages.map(p => p.slug)).toEqual(['notes/alpha-example', 'notes/beta-example']);
    const alpha = await chunkStats('notes/alpha-example');
    const beta = await chunkStats('notes/beta-example');
    expect(alpha.length).toBeGreaterThan(0);
    expect(beta.length).toBeGreaterThan(alpha.length);
    const all = [...alpha, ...beta];
    expect(plan.chunks).toBe(all.length);
    expect(plan.est_output_tokens).toBe(all.length * SYNOPSIS_MAX_TOKENS);
    // The ceiling matches the per-call reservation estimator summed over every chunk (one call per chunk).
    const document = (rows: typeof alpha) => rows.map(c => c.chunk_text).join('\n\n');
    const perCall = [alpha, beta].reduce((sum, rows) => sum + rows.reduce((s, c) => s + estimateSynopsisCallUsd(SYNOPSIS_MODEL, document(rows), c.chunk_text, SYNOPSIS_MAX_TOKENS), 0), 0);
    expect(plan.est_synopsis_usd).not.toBeNull();
    expect(plan.est_synopsis_usd!).toBeGreaterThan(0);
    expect(plan.est_synopsis_usd!).toBeCloseTo(perCall, 4);
    expect(plan.est_synopsis_usd).toBe(reservationCostUsd(SYNOPSIS_MODEL, 'chat', plan.est_input_tokens, plan.est_output_tokens));
    const price = lookupEmbeddingPrice(EMBED_MODEL);
    expect(price.kind).toBe('known');
    expect(plan.est_embedding_usd!).toBeGreaterThan(0);
    expect(plan.est_usd!).toBeCloseTo(plan.est_synopsis_usd! + plan.est_embedding_usd!, 10);
    const jobs = await engine.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'contextual_reindex_per_chunk'`);
    expect(Number(jobs[0]!.n)).toBe(0);
    expect(chatCalls).toBe(0);
  });

  test('mode switch to tokenmax on a TTY: previews the sweep and asks before running it; a no queues and spends nothing', async () => {
    const prompts: string[] = [];
    const saved = process.env.GBRAIN_NO_MODE_SWITCH_UX;
    delete process.env.GBRAIN_NO_MODE_SWITCH_UX;
    try {
      await quiet(() => runModeSwitchUx({ oldMode: 'balanced', newMode: 'tokenmax', engine, isTty: true,
        answerFn: async (prompt) => { prompts.push(prompt); return 'n'; } }));
    } finally {
      if (saved === undefined) delete process.env.GBRAIN_NO_MODE_SWITCH_UX; else process.env.GBRAIN_NO_MODE_SWITCH_UX = saved;
    }
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Run 'gbrain reindex --synopsis --yes' now?");
    expect(prompts[0]).toContain('for 2 page(s)');
    expect(prompts[0]).not.toContain('reindex --markdown');
    const jobs = await engine.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM minion_jobs`);
    expect(Number(jobs[0]!.n)).toBe(0);
    expect(chatCalls).toBe(0);
  });

  test('--yes under a cap below one synopsis call: the shared spend cap refuses the work, nothing is stamped, and the run says so', async () => {
    const result = await quiet(() => runReindexSynopsis(engine, ['--synopsis', '--yes', '--max-usd', '0.0001'], { pollMs: 100 }));
    expect(result.mode).toBe('run');
    expect(result.run!.cap_usd).toBe(0.0001);
    expect(result.run!.failed).toBe(2);
    expect(result.run!.synopsis).toBe(0);
    expect(chatCalls).toBe(0);
    const stamped = await engine.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM pages WHERE contextual_retrieval_mode = 'per_chunk_synopsis'`);
    expect(Number(stamped[0]!.n)).toBe(0);
    // The CLI exits 1 on failed jobs; clear the verdict so this file's process exits on its tests' result.
    expect(currentExitCode()).toBe(1);
    _resetCliExitVerdictForTests();
    process.exitCode = 0;
  });

  test('--yes queues and completes one job per page; pages land on the synopsis tier and a rerun has nothing to sweep', async () => {
    const result = await quiet(() => runReindexSynopsis(engine, ['--synopsis', '--yes', '--max-usd', '5'], { pollMs: 100 }));
    expect(result.mode).toBe('run');
    expect(result.run).toMatchObject({ synopsis: 2, title: 0, skipped: 0, failed: 0, already_attempted: 0, cap_usd: 5 });
    expect(chatCalls).toBe(result.plan!.chunks);
    const jobs = await engine.executeRaw<{ status: string; group_id: string | null; slug: string }>(
      `SELECT status, spend_authorization->>'group_id' AS group_id, data->>'page_slug' AS slug
         FROM minion_jobs WHERE name = 'contextual_reindex_per_chunk' AND id = ANY($1::int[]) ORDER BY id`, [result.run!.job_ids]);
    expect(jobs.map(j => j.slug)).toEqual(['notes/alpha-example', 'notes/beta-example']);
    expect(jobs.every(j => j.status === 'completed' && j.group_id === result.run!.group_id)).toBe(true);
    const modes = await engine.executeRaw<{ slug: string; mode: string | null }>(`SELECT slug, contextual_retrieval_mode AS mode FROM pages ORDER BY slug`);
    expect(modes).toEqual([
      { slug: 'notes/alpha-example', mode: 'per_chunk_synopsis' },
      { slug: 'notes/beta-example', mode: 'per_chunk_synopsis' },
      { slug: 'notes/large-example', mode: 'title' },
    ]);
    expect(result.coverage_after!.coverage_pct).toBe(100);
    const check = await checkSynopsisTierCoverage(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('100% of chunks');
    expect(check.fix).toBeUndefined();

    chatCalls = 0;
    const rerun = await quiet(() => runReindexSynopsis(engine, ['--synopsis', '--yes'], { pollMs: 100 }));
    expect(rerun.mode).toBe('preview');
    expect(rerun.plan!.pages).toEqual([]);
    expect(chatCalls).toBe(0);
  });

  test('--yes --json: stdout is one JSON document, the in-process worker logs go to stderr', async () => {
    await importFromContent(engine, 'notes/gamma-example', body('Gamma example', 2), { sourceId: 'default' });
    const out: string[] = [];
    const { log, error } = console;
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    console.log = (...args: unknown[]) => { out.push(args.map(String).join(' ') + '\n'); };
    console.error = () => {};
    process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let result;
    try { result = await runReindexSynopsis(engine, ['--synopsis', '--yes', '--max-usd', '5', '--json'], { pollMs: 100 }); }
    finally { console.log = log; console.error = error; process.stdout.write = write; process.stderr.write = writeErr; }
    expect(result.run).toMatchObject({ synopsis: 1, failed: 0 });
    expect(JSON.parse(out.join('')).run).toMatchObject({ synopsis: 1, failed: 0 });
  });

  test('a failed status poll stops the in-process worker and the run fails with that error instead of hanging', async () => {
    await importFromContent(engine, 'notes/delta-example', body('Delta example', 2), { sourceId: 'default' });
    const original = engine.executeRaw;
    let failed = false;
    engine.executeRaw = (async function (this: BrainEngine, sql: string, params?: unknown[]) {
      if (!failed && sql.startsWith('SELECT status FROM minion_jobs')) { failed = true; throw new Error('connection reset by the pooler'); }
      return original.call(this, sql, params as never);
    }) as typeof engine.executeRaw;
    try {
      const outcome = await Promise.race([
        quiet(() => runReindexSynopsis(engine, ['--synopsis', '--yes', '--max-usd', '5'], { pollMs: 100 })).then(() => 'resolved', (e: Error) => e.message),
        new Promise<string>(resolve => setTimeout(() => resolve('hung'), 20_000)),
      ]);
      expect(outcome).toBe('connection reset by the pooler');
    } finally { engine.executeRaw = original; }
  }, 30_000);
});
