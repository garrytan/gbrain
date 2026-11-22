/** The metric implementations. Every one returns an object in the gbrain-bakeoff-result/1 metric shape. */
import type { BrainEngine } from '../../../../src/core/engine.ts';
import type { Corpus } from './corpus.ts';
import { chunkKey, chunkVector, queryVector } from './corpus.ts';
import { importCorpus, hnswIndexInfo, pageSpec, type HnswMode } from './import.ts';
import { lastJsonLine, runChild, runCrashWriter } from './children.ts';
import { makeRng, median, r2, sleep, summarize } from './stats.ts';
import { openEngine, type StoreSpec } from './store.ts';
import { dirBytes, postgresServerMemory, selfPeakRssBytes } from './sys.ts';
import { writePage, type PageSpec } from './write-path.ts';

export type MetricResult = Record<string, unknown>;

export interface Ctx {
  engine: BrainEngine;
  store: StoreSpec;
  corpus: Corpus;
  quick: boolean;
  /** Cap on single-client loops, ms. */
  maxMs: number;
  hnsw: HnswMode;
  importWorkers: number;
  pgDataDir: string;
  nonce: string;
  log: (line: string) => void;
  /** Exact top-10 chunk rows per query, from the truth child process. */
  truth: number[][];
  keys: string[];
  /** Phase peaks for peak_rss_bytes. */
  memory: MemorySampler;
  afterImportBytes: number | null;
  /** Stats the runner records for the result notes. */
  facts: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------------------
// error handling and loops

type ErrorKind = 'conflict' | 'busy' | 'error';

export function classify(error: unknown): ErrorKind {
  const e = error as { name?: string; code?: string; message?: string; reason?: string; cause?: { code?: string } };
  if (e?.name === 'PageRevisionConflictError') return 'conflict';
  const code = e?.code ?? e?.cause?.code;
  if (code === '40001' || code === '40P01') return 'conflict';
  if (e?.name === 'PgliteBusyError' || /busy/i.test(String(e?.message ?? ''))) return 'busy';
  return 'error';
}

interface LoopResult {
  latencies: number[];
  wallMs: number;
  conflicts: number;
  retries: number;
  busy: number;
  errors: number;
  errorSample: string | null;
}

/** One client runs `op` back to back until `endAt`. A conflict or busy error retries the same operation. */
async function runClients(
  clients: number, durationMs: number, op: (client: number, iter: number) => Promise<void>,
): Promise<LoopResult> {
  const out: LoopResult = { latencies: [], wallMs: 0, conflicts: 0, retries: 0, busy: 0, errors: 0, errorSample: null };
  const started = performance.now();
  const endAt = started + durationMs;
  await Promise.all(Array.from({ length: clients }, async (_, client) => {
    for (let iter = 0; performance.now() < endAt; iter++) {
      const opStarted = performance.now();
      let attempts = 0;
      for (;;) {
        try {
          await op(client, iter * 1000 + attempts);
          out.latencies.push(performance.now() - opStarted);
          break;
        } catch (error) {
          const kind = classify(error);
          if (kind === 'conflict') out.conflicts++;
          else if (kind === 'busy') out.busy++;
          else {
            out.errors++;
            out.errorSample ??= `${(error as Error).name}: ${String((error as Error).message).split('\n')[0]!.slice(0, 200)}`;
            break;
          }
          attempts++;
          out.retries++;
          if (attempts > 200 || performance.now() > endAt + 5000) break;
        }
      }
    }
  }));
  out.wallMs = performance.now() - started;
  return out;
}

/** One client, `count` operations, stops early at the time cap. */
async function runSingle(count: number, maxMs: number, op: (i: number) => Promise<void>): Promise<{ latencies: number[]; wallMs: number }> {
  const latencies: number[] = [];
  const started = performance.now();
  for (let i = 0; i < count && performance.now() - started < maxMs; i++) {
    const t = performance.now();
    await op(i);
    latencies.push(performance.now() - t);
  }
  return { latencies, wallMs: performance.now() - started };
}

const windowMs = (ctx: Ctx) => (ctx.quick ? 1000 : 5000);

// ---------------------------------------------------------------------------------------------------------------
// memory

export class MemorySampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  serverRssPeak = 0;
  serverPssPeak: number | null = null;
  serverHwm = 0;
  serverProcesses = 0;
  constructor(private readonly pgDataDir: string | null) {}
  sample(): void {
    if (!this.pgDataDir) return;
    const m = postgresServerMemory(this.pgDataDir);
    if (!m) return;
    this.serverRssPeak = Math.max(this.serverRssPeak, m.rss_bytes);
    this.serverHwm = Math.max(this.serverHwm, m.hwm_bytes);
    if (m.pss_bytes !== null) this.serverPssPeak = Math.max(this.serverPssPeak ?? 0, m.pss_bytes);
    this.serverProcesses = Math.max(this.serverProcesses, m.processes);
  }
  start(): void { this.sample(); this.timer = setInterval(() => this.sample(), 1000); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.sample(); }
}

// ---------------------------------------------------------------------------------------------------------------
// helpers over the corpus

const pageSlugSource = (corpus: Corpus, i: number) => ({ slug: corpus.pages[i]!.slug, sourceId: corpus.pages[i]!.source_id });

function randomPage(rng: () => number, corpus: Corpus): number { return Math.floor(rng() * corpus.pages.length); }

/** A fresh 4-chunk page built from random corpus rows. */
function freshPage(corpus: Corpus, rng: () => number, slug: string, sourceId: string, extra: Record<string, unknown> = {}): PageSpec {
  const chunks = Array.from({ length: 4 }, () => {
    const row = Math.floor(rng() * corpus.chunks.length);
    return { text: corpus.chunks[row]!.text, vector: chunkVector(corpus, row) };
  });
  return {
    slug, sourceId, type: 'note', title: `Bench ${slug}`, frontmatter: { bench: true, ...extra },
    body: `# ${slug}\n\n${chunks.map(c => c.text).join('\n\n')}`, chunks,
  };
}

const vectorLiteral = (v: Float32Array) => `[${Array.prototype.join.call(v, ',')}]`;

// ---------------------------------------------------------------------------------------------------------------
// metrics

export async function metricImport(ctx: Ctx): Promise<MetricResult> {
  const stats = await importCorpus(ctx.engine, ctx.corpus, { workers: ctx.importWorkers, hnsw: ctx.hnsw, log: ctx.log });
  ctx.afterImportBytes = ctx.store.kind === 'pglite' ? dirBytes(ctx.store.dataDir!) : null;
  return { n: stats.pages, ...stats };
}

export async function metricGetPage(ctx: Ctx): Promise<MetricResult> {
  const rng = makeRng(101);
  let misses = 0;
  const { latencies, wallMs } = await runSingle(ctx.quick ? 500 : 20_000, ctx.maxMs, async () => {
    const { slug, sourceId } = pageSlugSource(ctx.corpus, randomPage(rng, ctx.corpus));
    if ((await ctx.engine.getPage(slug, { sourceId })) === null) misses++;
  });
  return summarize(latencies, wallMs, { misses });
}

export async function metricReadConcurrent(ctx: Ctx, clients: number): Promise<MetricResult> {
  const rngs = Array.from({ length: clients }, (_, c) => makeRng(200 + c));
  let misses = 0;
  const r = await runClients(clients, windowMs(ctx), async client => {
    const { slug, sourceId } = pageSlugSource(ctx.corpus, randomPage(rngs[client]!, ctx.corpus));
    if ((await ctx.engine.getPage(slug, { sourceId })) === null) misses++;
  });
  return summarize(r.latencies, r.wallMs, {
    clients, misses, errors: r.errors, error_sample: r.errorSample,
    ...(ctx.store.kind === 'pglite' ? { note: 'PGLite has one connection; concurrent clients are serialized' } : { pool_max: ctx.store.poolMax }),
  });
}

export async function metricListPages(ctx: Ctx): Promise<MetricResult> {
  const slugs = ctx.corpus.pages.filter(p => p.source_id === 'default').map(p => p.slug).sort();
  const usable = Math.max(1, Math.floor(slugs.length * 0.8));
  const rng = makeRng(301);
  let short = 0, rows = 0;
  const { latencies, wallMs } = await runSingle(ctx.quick ? 100 : 2000, ctx.maxMs, async () => {
    const after = slugs[Math.floor(rng() * usable)]!;
    const page = await ctx.engine.listPages({ sourceId: 'default', sort: 'slug', limit: 100, slugAfter: after, listColumnsOnly: true });
    rows += page.length;
    if (page.length < 100) short++;
  });
  return summarize(latencies, wallMs, { page_size: 100, source: 'default', short_results: short, avg_rows: r2(rows / Math.max(1, latencies.length)) });
}

export async function metricGetChunks(ctx: Ctx): Promise<MetricResult> {
  const rng = makeRng(401);
  let wrong = 0;
  const { latencies, wallMs } = await runSingle(ctx.quick ? 200 : 5000, ctx.maxMs, async () => {
    const { slug, sourceId } = pageSlugSource(ctx.corpus, randomPage(rng, ctx.corpus));
    const chunks = await ctx.engine.getChunks(slug, { sourceId, includeEmbedding: true });
    if (chunks.length !== 4 || !chunks.every(c => c.embedding && c.embedding.length === ctx.corpus.dims)) wrong++;
  });
  return summarize(latencies, wallMs, { with_embeddings: true, wrong_results: wrong });
}

async function indexScans(engine: BrainEngine): Promise<number | null> {
  try {
    const rows = await engine.executeRaw<{ n: number | string }>(
      `SELECT COALESCE(sum(idx_scan), 0)::bigint AS n FROM pg_stat_user_indexes WHERE indexrelname = 'idx_chunks_embedding'`);
    return rows.length ? Number(rows[0]!.n) : null;
  } catch { return null; }
}

function recallOf(results: { slug: string; chunk_index: number }[], truthKeys: string[]): { chunk: number; page: number; n: number } {
  const wantChunks = new Set(truthKeys);
  const wantPages = new Set(truthKeys.map(k => k.slice(0, k.lastIndexOf('#'))));
  const gotChunks = new Set(results.map(r => chunkKey(r.slug, r.chunk_index)));
  const gotPages = new Set(results.map(r => r.slug));
  let c = 0, p = 0;
  for (const k of wantChunks) if (gotChunks.has(k)) c++;
  for (const k of wantPages) if (gotPages.has(k)) p++;
  return { chunk: c / Math.max(1, wantChunks.size), page: p / Math.max(1, wantPages.size), n: results.length };
}

async function exactTopKeys(ctx: Ctx, q: Float32Array, filter: { sourceId?: string; type?: string }): Promise<string[]> {
  const literal = vectorLiteral(q);
  return ctx.engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL enable_indexscan = off');
    await tx.executeRaw('SET LOCAL enable_bitmapscan = off');
    const rows = await tx.executeRaw<{ slug: string; chunk_index: number }>(
      `SELECT p.slug, cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE cc.embedding IS NOT NULL AND ($2::text IS NULL OR p.source_id = $2) AND ($3::text IS NULL OR p.type = $3)
        ORDER BY cc.embedding <=> $1::vector LIMIT 10`,
      [literal, filter.sourceId ?? null, filter.type ?? null]);
    return rows.map(r => chunkKey(r.slug, Number(r.chunk_index)));
  });
}

export async function metricVectorExact(ctx: Ctx): Promise<MetricResult> {
  const queries = ctx.quick ? 10 : 200;
  let chunkRecall = 0, scored = 0;
  const { latencies, wallMs } = await runSingle(queries, ctx.maxMs, async i => {
    const keys = await exactTopKeys(ctx, queryVector(ctx.corpus, i), {});
    const want = new Set(ctx.truth[i]!.map(r => ctx.keys[r]!));
    chunkRecall += keys.filter(k => want.has(k)).length / 10;
    scored++;
  });
  return summarize(latencies, wallMs, {
    planned_queries: queries, recall_at_10: r2(chunkRecall / Math.max(1, scored)),
    plan: 'same SQL as the engine path, with enable_indexscan=off and enable_bitmapscan=off in the transaction (the SET statements are timed)',
  });
}

export async function metricVectorAnn(ctx: Ctx): Promise<MetricResult> {
  const queries = ctx.quick ? 20 : 200;
  const index = await hnswIndexInfo(ctx.engine);
  const before = await indexScans(ctx.engine);
  let chunk = 0, page = 0, results = 0, scored = 0;
  const { latencies, wallMs } = await runSingle(queries, ctx.maxMs, async i => {
    const found = await ctx.engine.searchVector(queryVector(ctx.corpus, i), { limit: 10 });
    const r = recallOf(found, ctx.truth[i]!.map(row => ctx.keys[row]!));
    chunk += r.chunk; page += r.page; results += r.n; scored++;
  });
  await sleep(1500); // Postgres flushes per-backend index statistics about once a second
  const after = await indexScans(ctx.engine);
  return summarize(latencies, wallMs, {
    planned_queries: queries,
    recall_at_10: r2(chunk / Math.max(1, scored)),
    recall_at_10_page: r2(page / Math.max(1, scored)),
    avg_results: r2(results / Math.max(1, scored)),
    ann_index: index.present ? (index.valid ? 'hnsw' : 'invalid') : 'absent (exact scan fallback)',
    index_scans: before !== null && after !== null ? after - before : null,
    hnsw_mode: ctx.hnsw,
    path: 'engine.searchVector(): page-grain results (best chunk per page) through the HNSW candidate pool; recall_at_10 is chunk-level against exact truth, recall_at_10_page compares distinct pages',
  });
}

async function filteredMetric(ctx: Ctx, filter: { sourceId: string; type?: string }, selectivity: number): Promise<MetricResult> {
  const queries = ctx.quick ? 20 : 200;
  const scoredQueries = ctx.quick ? 10 : 50;
  const times: number[] = [];
  const started = performance.now();
  const found: { slug: string; chunk_index: number }[][] = [];
  for (let i = 0; i < queries && performance.now() - started < ctx.maxMs; i++) {
    const t = performance.now();
    const r = await ctx.engine.searchVector(queryVector(ctx.corpus, i), { limit: 10, sourceId: filter.sourceId, ...(filter.type ? { type: filter.type as never } : {}) });
    times.push(performance.now() - t);
    found.push(r);
  }
  const wallMs = performance.now() - started;
  let chunk = 0, page = 0, results = 0, scored = 0;
  const scoreStarted = performance.now();
  for (let i = 0; i < Math.min(scoredQueries, found.length) && performance.now() - scoreStarted < ctx.maxMs; i++) {
    const keys = await exactTopKeys(ctx, queryVector(ctx.corpus, i), filter); // untimed
    const r = recallOf(found[i]!, keys);
    chunk += r.chunk; page += r.page; results += r.n; scored++;
  }
  return summarize(times, wallMs, {
    planned_queries: queries, filter, selectivity: Number(selectivity.toFixed(4)),
    recall_at_10: r2(chunk / Math.max(1, scored)), recall_at_10_page: r2(page / Math.max(1, scored)),
    avg_results: r2(results / Math.max(1, scored)), recall_scored_queries: scored,
  });
}

async function filteredSelectivity(ctx: Ctx): Promise<{ type: string; sourceShare: number; typeShare: number }> {
  const total = ctx.corpus.pages.length;
  const inB = ctx.corpus.pages.filter(p => p.source_id === 'scale-b');
  const counts = new Map<string, number>();
  for (const p of inB) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
  const [type, n] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ['note', 0];
  return { type, sourceShare: inB.length / total, typeShare: n / total };
}

export async function metricVectorFiltered10(ctx: Ctx): Promise<MetricResult> {
  const s = await filteredSelectivity(ctx);
  return filteredMetric(ctx, { sourceId: 'scale-b' }, s.sourceShare);
}

export async function metricVectorFiltered1(ctx: Ctx): Promise<MetricResult> {
  const s = await filteredSelectivity(ctx);
  return filteredMetric(ctx, { sourceId: 'scale-b', type: s.type }, s.typeShare);
}

export async function metricPutPage(ctx: Ctx): Promise<MetricResult> {
  const rng = makeRng(501);
  const { latencies, wallMs } = await runSingle(ctx.quick ? 30 : 500, ctx.maxMs, async () => {
    await writePage(ctx.engine, pageSpec(ctx.corpus, randomPage(rng, ctx.corpus)), { force: true });
  });
  return summarize(latencies, wallMs, {
    chunks_per_page: 4, durable: 'one transaction per page, committed before the next starts',
    scope: 'rewrites an existing corpus page with its own text and vectors (force: true), replacing its 4 chunks',
  });
}

export async function metricWrite(ctx: Ctx, clients: number): Promise<MetricResult> {
  const rngs = Array.from({ length: clients }, (_, c) => makeRng(600 + c));
  const r = await runClients(clients, windowMs(ctx), async (client, iter) => {
    await writePage(ctx.engine, freshPage(ctx.corpus, rngs[client]!, `bench/${ctx.nonce}/w${clients}-c${client}-${iter}`, 'default'));
  });
  return summarize(r.latencies, r.wallMs, {
    clients, committed: r.latencies.length, conflicts: r.conflicts, retries: r.retries, busy: r.busy,
    errors: r.errors, error_sample: r.errorSample,
    chunks_per_page: 4, scope: 'new pages in source default, disjoint slugs, one transaction each',
  });
}

export async function metricWriteHot(ctx: Ctx): Promise<MetricResult> {
  const slug = `bench/${ctx.nonce}/hot-counter`;
  const body = (n: number) => `counter ${n}`;
  await ctx.engine.putPage(slug, {
    type: 'note', title: 'hot counter', compiled_truth: body(0), timeline: '', frontmatter: { counter: 0 }, content_hash: `hot-0`,
  }, { sourceId: 'default' });
  const r = await runClients(16, windowMs(ctx), async () => {
    await ctx.engine.transaction(async tx => {
      const page = await tx.getPage(slug, { sourceId: 'default' });
      if (!page) throw new Error('hot page missing');
      const next = Number((page.frontmatter as { counter?: number }).counter ?? 0) + 1;
      await tx.putPage(slug, {
        type: 'note', title: 'hot counter', compiled_truth: body(next), timeline: '', frontmatter: { counter: next }, content_hash: `hot-${next}`,
      }, { sourceId: 'default', expectedRevision: page.knowledge_revision ?? null, inline: true });
    });
  });
  const final = await ctx.engine.getPage(slug, { sourceId: 'default' });
  const finalCounter = Number((final?.frontmatter as { counter?: number } | undefined)?.counter ?? NaN);
  return summarize(r.latencies, r.wallMs, {
    clients: 16, committed: r.latencies.length, conflicts: r.conflicts, retries: r.retries, busy: r.busy,
    errors: r.errors, error_sample: r.errorSample, final_counter: finalCounter,
    final_equals_committed: finalCounter === r.latencies.length,
    scope: 'compare-and-swap: getPage then putPage with expectedRevision in one transaction; a conflict retries the whole transaction',
  });
}

export async function metricWriteHotUnguarded(ctx: Ctx): Promise<MetricResult> {
  const key = `bench.hot.${ctx.nonce}`;
  await ctx.engine.setConfig(key, '0');
  const r = await runClients(16, windowMs(ctx), async () => {
    await ctx.engine.transaction(async tx => {
      const n = Number((await tx.getConfig(key)) ?? '0');
      await tx.setConfig(key, String(n + 1));
    });
  });
  const final = Number((await ctx.engine.getConfig(key)) ?? NaN);
  await ctx.engine.unsetConfig(key);
  const committed = r.latencies.length;
  return summarize(r.latencies, r.wallMs, {
    clients: 16, committed, conflicts: r.conflicts, retries: r.retries, busy: r.busy, errors: r.errors, error_sample: r.errorSample,
    final_counter: final, lost_updates: committed - final, final_equals_committed: final === committed,
    scope: 'extra metric: a naive getConfig/setConfig read-modify-write in a transaction, which is what code without a revision check does',
  });
}

// ---------------------------------------------------------------------------------------------------------------
// process-level metrics

/** PGLite allows one owning process, so the parent must let go before a child opens the same directory. */
async function releaseForChild(ctx: Ctx): Promise<void> {
  if (ctx.store.kind === 'pglite') await ctx.engine.disconnect();
}
async function reacquire(ctx: Ctx): Promise<void> {
  if (ctx.store.kind === 'pglite') ctx.engine = await openEngine(ctx.store);
}

export async function metricColdOpen(ctx: Ctx): Promise<MetricResult> {
  const { slug, sourceId } = pageSlugSource(ctx.corpus, 0);
  const runs: { ms: number; connect_ms: number; first_get_ms: number; process_wall_ms: number }[] = [];
  const failures: string[] = [];
  await releaseForChild(ctx);
  try {
    for (let i = 0; i < 3; i++) {
      const run = await runChild({ kind: 'cold-open', store: ctx.store, slug, sourceId }, 120_000);
      const out = lastJsonLine(run.stdout);
      if (out?.ok && out.found) runs.push({ ms: Number(out.ms), connect_ms: Number(out.connect_ms), first_get_ms: Number(out.first_get_ms), process_wall_ms: run.wallMs });
      else failures.push(String(out?.message ?? run.stderr.slice(-200) ?? 'no output'));
    }
  } finally {
    await reacquire(ctx);
  }
  if (runs.length === 0) return { n: 0, ms: null, error: failures[0] ?? 'all runs failed' };
  return {
    n: runs.length,
    ms: r2(median(runs.map(r => r.ms))),
    connect_ms: r2(median(runs.map(r => r.connect_ms))),
    first_get_ms: r2(median(runs.map(r => r.first_get_ms))),
    process_wall_ms: r2(median(runs.map(r => r.process_wall_ms))),
    runs_ms: runs.map(r => r2(r.ms)),
    failures: failures.length,
    note: 'median of 3 fresh processes: createEngine + connect + first getPage. The OS file cache is warm, and for postgres the server was already running.',
  };
}

export async function metricCrashRecovery(ctx: Ctx): Promise<MetricResult> {
  const nonce = `${ctx.nonce}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const killAfterMs = ctx.quick ? 1000 : 2000;
  await releaseForChild(ctx);
  let run: Awaited<ReturnType<typeof runCrashWriter>>;
  try {
    run = await runCrashWriter({ kind: 'crash-writer', store: ctx.store, nonce, dims: ctx.corpus.dims }, killAfterMs, 120_000);
  } catch (error) {
    await reacquire(ctx);
    throw error;
  }
  const reopenStart = performance.now();
  ctx.engine = await openEngine(ctx.store);
  await ctx.engine.executeRaw('SELECT count(*)::int AS n FROM pages');
  const reopenMs = performance.now() - reopenStart;
  if (!run.ready) return { n: 0, acked: 0, error: `writer never became ready: ${run.stderr}` };

  const rows = await ctx.engine.executeRaw<{ slug: string; chunks: number | string }>(
    `SELECT p.slug, count(cc.id)::int AS chunks FROM pages p LEFT JOIN content_chunks cc ON cc.page_id = p.id
      WHERE p.slug LIKE $1 GROUP BY p.slug`, [`bench/crash-${nonce}-%`]);
  const present = new Map(rows.map(r => [r.slug, Number(r.chunks)]));
  const lost = run.acked.filter(s => !present.has(s)).length;
  const badChunkCounts = [...present.values()].filter(c => c !== 4).length;
  const orphan = await ctx.engine.executeRaw<{ n: number | string }>(
    'SELECT count(*)::int AS n FROM content_chunks cc LEFT JOIN pages p ON p.id = cc.page_id WHERE p.id IS NULL');
  let sealedOk = 0;
  const sample = run.acked.slice(-20);
  for (const slug of sample) if ((await ctx.engine.getChunks(slug, { sourceId: 'default', includeEmbedding: true })).length === 4) sealedOk++;
  let writable = true;
  try {
    await writePage(ctx.engine, freshPage(ctx.corpus, makeRng(777), `bench/${ctx.nonce}/after-crash`, 'default'));
  } catch { writable = false; }
  const acked = run.acked.length;
  return {
    n: 1, acked, lost, reopen_ms: r2(reopenMs), consistent: badChunkCounts === 0 && Number(orphan[0]?.n ?? 0) === 0 && sealedOk === sample.length,
    pages_found: present.size, unacked_committed: Math.max(0, present.size - (acked - lost)),
    pages_with_wrong_chunk_count: badChunkCounts, orphan_chunks: Number(orphan[0]?.n ?? 0),
    sealed_chunks_readable: `${sealedOk}/${sample.length} of the last acked pages`, writable_after: writable,
    kill_after_ms: killAfterMs,
    note: ctx.store.kind === 'pglite'
      ? 'the writer process is SIGKILLed mid-stream; the PGLite data dir is reopened by this process'
      : 'only the CLIENT process is killed; the server keeps running, so a server-acknowledged commit cannot be lost here and this does not test a server crash or power loss',
  };
}

export async function metricSecondProcess(ctx: Ctx): Promise<MetricResult> {
  const { slug, sourceId } = pageSlugSource(ctx.corpus, 0);
  const timeoutMs = ctx.quick ? 5000 : 40_000;
  const run = await runChild({ kind: 'open-probe', store: ctx.store, slug, sourceId }, timeoutMs);
  const out = lastJsonLine(run.stdout);
  let outcome: string;
  if (run.timedOut) outcome = `no answer within ${r2(timeoutMs / 1000)} s (killed)`;
  else if (out?.ok) outcome = 'opened';
  else outcome = `refused: ${out?.name ?? 'unknown'}${out?.code ? ` (${out.code})` : ''} after ${r2(run.wallMs / 1000)} s${out?.message ? `: ${out.message}` : ''}`;
  let ownerOk = true;
  try { ownerOk = (await ctx.engine.getPage(slug, { sourceId })) !== null; } catch { ownerOk = false; }
  return {
    n: 1, outcome, owner_still_ok: ownerOk, process_wall_ms: r2(run.wallMs),
    ...(out?.ok ? { first_get_ms: r2(Number(out.first_get_ms)), open_ms: r2(Number(out.connect_ms)) } : {}),
    note: ctx.store.kind === 'pglite'
      ? 'direct open of the data dir by a second process while the owner is open; the owner-socket client path (multi-client mode) is not measured'
      : 'postgres accepts any number of client processes',
  };
}

export async function metricDiskBytes(ctx: Ctx): Promise<MetricResult> {
  const rel = async (sql: string) => Number((await ctx.engine.executeRaw<{ n: number | string }>(sql))[0]?.n ?? 0);
  const parts = {
    content_chunks_bytes: await rel(`SELECT pg_total_relation_size('content_chunks') AS n`),
    pages_bytes: await rel(`SELECT pg_total_relation_size('pages') AS n`),
    hnsw_index_bytes: await rel(`SELECT COALESCE(pg_relation_size(to_regclass('idx_chunks_embedding')), 0) AS n`),
  };
  if (ctx.store.kind === 'pglite') {
    const bytes = dirBytes(ctx.store.dataDir!);
    return { bytes, after_import_bytes: ctx.afterImportBytes, after_writes_bytes: bytes, ...parts, scope: 'recursive size of the PGLite data dir (apparent bytes)' };
  }
  const dbBytes = await rel(`SELECT pg_database_size(current_database()) AS n`);
  return {
    bytes: dbBytes, after_writes_bytes: dbBytes, after_import_bytes: ctx.facts.pgBytesAfterImport ?? null,
    wal_bytes_cluster: dirBytes(`${ctx.pgDataDir}/pg_wal`), ...parts,
    scope: 'pg_database_size of the benchmark database; WAL is cluster-wide (pg_wal) and not part of bytes',
  };
}

export async function metricPeakRss(ctx: Ctx): Promise<MetricResult> {
  ctx.memory.sample();
  const self = selfPeakRssBytes();
  const server = ctx.memory.serverRssPeak;
  // PSS splits shared_buffers across the backends that map it; summed RSS counts it once per backend.
  const serverBest = ctx.memory.serverPssPeak ?? server;
  return {
    bytes: self + serverBest, process_bytes: self, server_rss_peak_bytes: ctx.store.kind === 'postgres' ? server : null,
    server_pss_peak_bytes: ctx.memory.serverPssPeak, server_processes_peak: ctx.memory.serverProcesses || null,
    harness_overhead_rss_bytes: ctx.facts.harnessRssBytes ?? null,
    scope: ctx.store.kind === 'pglite'
      ? 'VmHWM of the benchmark process (it hosts PGLite); child processes are not included'
      : 'VmHWM of the benchmark process plus the highest summed RSS of the postmaster and its children seen by a 1 s sampler (summed RSS counts shared_buffers once per backend that touched it, so it overstates; `bytes` uses the summed PSS when readable)',
    note: 'process_bytes includes the in-memory corpus held by the harness (see harness_overhead_rss_bytes); the exact-truth computation runs in a child process',
  };
}

export const METRICS: { name: string; run: (ctx: Ctx) => Promise<MetricResult> }[] = [
  { name: 'import', run: metricImport },
  { name: 'cold_open', run: metricColdOpen },
  { name: 'get_page', run: metricGetPage },
  { name: 'read_c1', run: ctx => metricReadConcurrent(ctx, 1) },
  { name: 'read_c4', run: ctx => metricReadConcurrent(ctx, 4) },
  { name: 'read_c16', run: ctx => metricReadConcurrent(ctx, 16) },
  { name: 'list_pages', run: metricListPages },
  { name: 'get_chunks', run: metricGetChunks },
  { name: 'vector_exact', run: metricVectorExact },
  { name: 'vector_ann', run: metricVectorAnn },
  { name: 'vector_filtered_10', run: metricVectorFiltered10 },
  { name: 'vector_filtered_1', run: metricVectorFiltered1 },
  { name: 'put_page', run: metricPutPage },
  { name: 'write_w1', run: ctx => metricWrite(ctx, 1) },
  { name: 'write_w4', run: ctx => metricWrite(ctx, 4) },
  { name: 'write_w16', run: ctx => metricWrite(ctx, 16) },
  { name: 'write_hot_w16', run: metricWriteHot },
  { name: 'write_hot_w16_unguarded', run: metricWriteHotUnguarded },
  { name: 'crash_recovery', run: metricCrashRecovery },
  { name: 'second_process', run: metricSecondProcess },
  { name: 'disk_bytes', run: metricDiskBytes },
  { name: 'peak_rss_bytes', run: metricPeakRss },
];
