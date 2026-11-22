#!/usr/bin/env bun
/**
 * gbrain baseline: runs the bake-off workload (gbrain-bakeoff-result/1) against gbrain's CURRENT engines,
 * PGLite and Postgres, through the real engine code (createEngine, putPage, upsertChunks, searchVector, ...).
 *
 *   bun rust/bench/baseline/run.ts --engine pglite   --corpus /var/tmp/w1/corpus-10k --scale 10k --out pglite-10k.json
 *   bun rust/bench/baseline/run.ts --engine postgres --corpus /var/tmp/w1/corpus-10k --scale 10k --out pg-10k.json \
 *       --database-url postgresql://postgres@127.0.0.1:55432/bakeoff_10k --create-db
 *
 * See README.md for every flag and what each metric measures. No embedding or chat provider is ever called:
 * all vectors come from the corpus, and provider keys are removed from this process and its children.
 */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { childMain, lastJsonLine, runChild } from './lib/children.ts';
import { scrubProcessEnv } from './lib/sys.ts';

const argv = process.argv.slice(2);
const removedSecrets = scrubProcessEnv();

if (argv.includes('--child')) {
  await childMain();
  process.exit(0);
}

const { loadCorpus } = await import('./lib/corpus.ts');
const { METRICS, MemorySampler } = await import('./lib/metrics.ts');
type Ctx = import('./lib/metrics.ts').Ctx;
const store = await import('./lib/store.ts');
const { machineInfo, gitInfo, selfPeakRssBytes } = await import('./lib/sys.ts');
const { r2 } = await import('./lib/stats.ts');
const { parseArgs } = await import('./lib/args.ts');
const { hnswIndexInfo } = await import('./lib/import.ts');

const METRIC_NAMES = METRICS.map(m => m.name);
const args = parseArgs(argv, METRIC_NAMES);

const log = (line: string) => process.stderr.write(`[baseline] ${line}\n`);
const started_at = new Date().toISOString();
const only = args.only ?? METRIC_NAMES;

// Everything gbrain reads from its config dir goes to a scratch directory, never ~/.gbrain.
process.env.GBRAIN_HOME = args.home;
mkdirSync(args.home, { recursive: true });

const corpusDir = resolve(args.corpus);
const corpus = await loadCorpus(corpusDir, args.limitPages);
const fullCorpus = args.limitPages === undefined || args.limitPages >= corpus.manifest.pages;
const harnessRssBytes = process.memoryUsage().rss;
log(`corpus ${corpus.pages.length} pages / ${corpus.chunks.length} chunks / ${corpus.dims} dims (${removedSecrets} credential-like env vars removed)`);

const spec: import('./lib/store.ts').StoreSpec = args.engine === 'pglite'
  ? { kind: 'pglite', dataDir: resolve(args.dataDir) }
  : { kind: 'postgres', databaseUrl: args.databaseUrl!, poolMax: args.poolMax };

// Store preparation. Destructive steps only ever touch a store this runner created (marker).
if (spec.kind === 'pglite') {
  store.preparePgliteDir(spec.dataDir!, args.fresh);
} else if (args.createDb) {
  log(`database: ${await store.preparePostgresDatabase(spec.databaseUrl!, args.fresh)}`);
}

// Exact ground truth in a child process (shared with the Rust harness through <corpus>/truth_top10.json).
const needsTruth = only.some(n => ['vector_exact', 'vector_ann'].includes(n));
let truth: number[][] = [];
let truthFacts: Record<string, unknown> = {};
if (needsTruth) {
  const needed = args.quick ? 20 : 200;
  const run = await runChild({ kind: 'truth', corpusDir, pageLimit: fullCorpus ? undefined : args.limitPages, needed }, 30 * 60_000);
  const out = lastJsonLine(run.stdout) as { top10: number[][]; source: string; compute_seconds: number | null; persisted: boolean } | null;
  if (!out) throw new Error(`exact truth failed: ${run.stderr.slice(-400)}`);
  truth = out.top10;
  truthFacts = { source: out.source, compute_seconds: out.compute_seconds, persisted_to_corpus_dir: out.persisted };
  log(`exact truth for ${truth.length} queries (${out.source})`);
}

const engine = await store.openEngine(spec, { initSchema: true });
const { rowKeys } = await import('./lib/corpus.ts');
const memory = new MemorySampler(spec.kind === 'postgres' ? args.pgDataDir : null);
memory.start();

const nonce = Date.now().toString(36);
const ctx: Ctx = {
  engine, store: spec, corpus, quick: args.quick, maxMs: args.maxSeconds * 1000, hnsw: args.hnsw, importWorkers: args.importWorkers,
  pgDataDir: args.pgDataDir, nonce, log, truth, keys: rowKeys(corpus), memory, afterImportBytes: null,
  facts: { harnessRssBytes },
};

// Import needs an empty store; other metrics need a loaded one.
const existingPages = await store.countPages(engine);
if (only.includes('import')) {
  if (existingPages > 0) throw new Error(`the store already holds ${existingPages} pages; use --fresh to start over, or --only to skip the import`);
} else if (existingPages < corpus.pages.length) {
  throw new Error(`the store holds ${existingPages} pages but the corpus has ${corpus.pages.length}; run the import first`);
}

const metrics: Record<string, unknown> = {};
const notes: string[] = [];
const wanted = METRICS.filter(m => only.includes(m.name));
for (const metric of wanted) {
  log(`${metric.name} ...`);
  const t = performance.now();
  try {
    metrics[metric.name] = await metric.run(ctx);
  } catch (error) {
    const e = error as Error;
    metrics[metric.name] = { n: 0, error: `${e.name}: ${String(e.message).split('\n')[0]!.slice(0, 300)}` };
    log(`${metric.name} failed: ${e.message}`);
  }
  log(`${metric.name} done in ${r2((performance.now() - t) / 1000)} s`);
  if (metric.name === 'import') {
    memory.sample();
    if (spec.kind === 'postgres') {
      const rows = await ctx.engine.executeRaw<{ n: number | string }>('SELECT pg_database_size(current_database()) AS n');
      ctx.facts.pgBytesAfterImport = Number(rows[0]?.n);
    }
  }
}
memory.stop();

const index = await hnswIndexInfo(ctx.engine).catch(() => ({ present: false, valid: null, bytes: null }));
const settings: Record<string, string> = {};
for (const name of ['shared_buffers', 'synchronous_commit', 'fsync', 'full_page_writes', 'max_connections', 'wal_level', 'work_mem', 'maintenance_work_mem']) {
  try { settings[name] = (await ctx.engine.executeRaw<{ v: string }>('SELECT current_setting($1) AS v', [name]))[0]?.v ?? ''; } catch { /* ignore */ }
}
const versions = await store.versions(ctx.engine);
const pkg = await Bun.file(new URL('../../../package.json', import.meta.url)).json().catch(() => ({ version: 'unknown' }));
const pages = await store.countPages(ctx.engine);
const chunks = await store.countChunks(ctx.engine);
await ctx.engine.disconnect();

const selectivity = (metrics.vector_filtered_1 as { selectivity?: number; filter?: { type?: string } } | undefined);
notes.push(
  `Engine: gbrain ${pkg.version} ${args.engine} through createEngine/connect/initSchema. The embedding column is vector(${store.EMBEDDING_DIMS}) (gbrain's default; no provider is configured or called).`,
  `Import path: per page, one engine.transaction of putPage + upsertChunks (embeddings, chunker-version seal) + sealPageTextProjection, as importFromContent does; markdown parsing, chunking, embedding, tag/link projection and version snapshots are not run, so import is store work only.`,
  `HNSW mode ${args.hnsw}: ${args.hnsw === 'inline' ? 'idx_chunks_embedding exists during import (gbrain default; every insert updates the graph)' : args.hnsw === 'deferred' ? 'idx_chunks_embedding dropped for import and built afterwards (timed in import.hnsw_build_seconds)' : 'no HNSW index; vector_ann falls back to exact scans'}. Final index: ${index.present ? `present, ${index.bytes} bytes` : 'absent'}.`,
  `Metrics run in this order: ${wanted.map(m => m.name).join(', ')}. Vector metrics run before any write so the duplicate corpus vectors the write metrics add cannot distort recall.`,
  `OS file cache is warm for every metric (cold_open measures a cold process, not a cold cache).`,
  spec.kind === 'pglite'
    ? 'PGLite is one connection in one process: read_c4/read_c16 and write_w4/w16 measure serialized clients, not parallel ones.'
    : `Postgres pool_max=${args.poolMax} (gbrain's default is 10; raised so 16 clients get 16 connections). Isolation is the default READ COMMITTED.`,
  `Filtered vector search: source scale-b holds only the person and note pages of this corpus, so scale-b + one type is ${selectivity?.selectivity !== undefined ? r2(selectivity.selectivity * 100) : 'n/a'}% of pages (type ${selectivity?.filter?.type ?? 'n/a'}), not the spec's ~2.5%.`,
  `Truth for recall: ${JSON.stringify(truthFacts)}. vector_ann is page-grain (searchVector returns the best chunk per page) so recall_at_10 (chunk-level) can sit below 1 even with a perfect index; recall_at_10_page compares distinct pages.`,
  spec.kind === 'pglite' && settings.fsync === 'off'
    ? 'PGLite reports fsync=off: a commit reaches the data files through the WASM filesystem but is not fsync-confirmed the way Postgres fsyncs its WAL, so PGLite write latency is not a like-for-like durable commit.'
    : `Server durability: synchronous_commit=${settings.synchronous_commit}, fsync=${settings.fsync}.`,
  `write_hot_w16_unguarded is an extra metric, not part of the spec.`,
  `Corpus: ${corpus.manifest.origin ?? 'unknown origin'}. Queries are held out of the corpus.`,
);
if (!fullCorpus) notes.push(`Smoke run on the first ${corpus.pages.length} pages only (--limit-pages); not comparable with full-corpus results.`);
if (args.quick) notes.push('--quick: short windows and fewer operations; for smoke testing only.');

const result = {
  format: 'gbrain-bakeoff-result/1',
  engine: args.engine,
  variant: `hnsw=${args.hnsw} import-workers=${args.importWorkers}${spec.kind === 'postgres' ? ` pool=${args.poolMax}` : ''}${args.quick ? ' quick' : ''}`,
  scale: args.scale,
  chunks: corpus.chunks.length,
  pages: corpus.pages.length,
  store_after: { pages, chunks },
  machine: machineInfo(),
  git_sha: gitInfo().git_sha,
  started_at,
  versions: { ...versions, gbrain: pkg.version as string },
  server_settings: settings,
  metrics,
  notes,
};

const out = resolve(args.out);
mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n');
renameSync(tmp, out);
log(`wrote ${out} (process peak RSS ${r2(selfPeakRssBytes() / 2 ** 20)} MiB)`);
process.exit(0);
