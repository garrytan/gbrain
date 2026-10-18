#!/usr/bin/env bun
/**
 * HNSW vector-search bench (#6132 iterative scan; E5.4 scale and build
 * options). Opt-in, never run in CI, not shipped in the CLI.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
 *     bun scripts/bench/hnsw-iterative-scan.ts --dims 1024 [--chunks 30000]
 *       [--queries 100] [--embed voyage|openai|synthetic] [--cache DIR] [--json] [--keep]
 *
 * Creates `gbrain_bench_hnsw_iter_<hex>` on the DATABASE_URL server (the role
 * needs CREATEDB and CREATE EXTENSION vector, and superuser for the latent
 * corpus's visibility flips), seeds it, builds the HNSW index and measures
 * every query through PostgresEngine.searchVector: the index walk, the
 * pooled statement, its escalations, the exact fallback and the
 * `onVectorPoolMeta` signal that hybrid search turns into
 * `vector_candidates_incomplete`. Recall@k is of pages, against an exact
 * max-pooled ranking under the same filter. Drops the database unless --keep.
 *
 * Corpora:
 *   --corpus repo (default): one page per document of this repository's
 *     docs/, skills/, src/ and test/ text (chunks of up to 800 characters, at
 *     most 60 per page), embedded for real (`--embed voyage`: voyage-4 at 1024
 *     dims; `--embed openai`: text-embedding-3-small at 1536; `synthetic`: a
 *     16-dim latent tiled across the dimensions, no network), cached under
 *     `--cache` (default ~/.capy/work/w6/bench-cache). Queries are the first
 *     sentence of random chunks; truth is the engine's exact statement.
 *   --corpus latent: `--chunks` synthetic-latent chunks (see
 *     hnsw-latent-corpus.ts: topic/page/chunk structure, low-rank local
 *     variation, about 1,500 characters of text per chunk), loaded by
 *     `--workers` parallel binary COPY streams while the exact per-page truth
 *     is computed in float64 in the same pass. `--verify N` checks N queries
 *     per filter against the engine's own exact statement. No network.
 *     Shape knobs: --seed, --latent-rank, --latent-noise, --latent-query-noise.
 *
 * Measurement grid (each cell: recall@k, p50/p95/p99 ms, short results,
 * `vector_candidates_incomplete`, which statement served, exact fallbacks):
 *   --filters  none,source10,source50,vis50,vis10 (repo default: source10,source50).
 *              sourceN: sourceIds covering N% of pages (latent and dir: bench-a,
 *              then bench-a + bench-b, sized by --source-shares a,b, default
 *              0.1,0.4); visN: excludePrivate with (100-N)% of pages
 *              `visibility: private` (latent and dir only); a `type` suffix
 *              (source10type) adds `type: 'note'`, which skips the walk.
 *   --k        10,50
 *   --modes    strict_order,relaxed_order (latent default: relaxed_order)
 *   --ef       shipped,40,100,200,400 (repo default: shipped). `shipped` is the
 *              engine's own sizing (hnswEfSearchFor of the attempt's window); a
 *              number pins hnsw.ef_search for every attempt of the search,
 *              set inside the engine's transaction after its own settings.
 *   --max-scan-tuples shipped,20000: the same pin for hnsw.max_scan_tuples (main
 *              grid only; `shipped` keeps the pool's 2,000 × 4^escalation).
 *   --states   fresh,analyze (latent default): before the main grid, EXPLAIN
 *              and a shipped-only pass in the stats state right after the
 *              index build (autovacuum off, never ANALYZEd) and after a plain
 *              ANALYZE (`projection` instead runs only the narrow
 *              ANALYZE pages(...) that import and sync end with). The main
 *              grid always runs after VACUUM ANALYZE plus
 *              refreshProjectionStatistics.
 *   --explain  EXPLAIN (ANALYZE, BUFFERS, SETTINGS) of the index walk and the
 *              pooled statement per state, filter, k and random_page_cost
 *              (server value and 4), written under --out.
 *   --builds   vector:16:128,halfvec:16:64[:mwm=1GB][:par=2] (E5.4.2): after
 *              the main grid, rebuild idx_chunks_embedding with each option
 *              (CREATE INDEX CONCURRENTLY, as the deferred ANN build does; a
 *              halfvec spec converts the column first) and record build
 *              seconds, index bytes and a grid over --build-filters
 *              (none,source10) and --build-ef (shipped,40).
 *   --build-mwm / --build-parallel: maintenance_work_mem and
 *              max_parallel_maintenance_workers for builds (default 1GB, 0).
 *
 * Output: a markdown table on stdout (or --json), and --out DIR (default
 * ~/.capy/work/hnsw-bench/<corpus>-<chunks>) gets results.json (rewritten
 * after every cell), truth.json and explain/*.txt. `--db NAME` reuses a
 * database a previous `--keep` latent run loaded (with its --out truth.json);
 * `--no-grid` skips the main grid, for adding --builds to a kept database.
 */
import { randomBytes, createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { cpus, homedir, totalmem } from 'node:os';
import { join, relative } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { refreshProjectionStatistics } from '../../src/core/search/projection-statistics.ts';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import type { VectorPoolAttempt } from '../../src/core/search/vector-pool.ts';
import type { HnswIterativeScanMode } from '../../src/core/search/hnsw-iterative-scan.ts';
import type { SearchOpts, VectorPoolMeta } from '../../src/core/types.ts';
import {
  buildBasis, buildQueries, Generator, GROUPS, hashPage, Rng, LATENT_DEFAULTS, loadLatentCorpus, pageSlug, planPages, SOURCE_IDS, topicCount, TRUTH_K,
  type Group, type LatentParams,
} from './hnsw-latent-corpus.ts';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}
const list = (name: string, fallback: string) => flag(name, fallback).split(',').map(s => s.trim()).filter(Boolean);
const CORPUS = flag('corpus', 'repo') as 'repo' | 'latent' | 'dir';
/** latent and dir corpora are bulk-loaded with their truth computed in the same pass. */
const LATENT = CORPUS === 'latent' || CORPUS === 'dir';
const CORPUS_DIR = flag('corpus-dir', '');
const MAX_USD = Number(flag('max-usd', '28'));
const EMBED = (CORPUS === 'latent' ? 'synthetic' : flag('embed', 'voyage')) as 'voyage' | 'openai' | 'synthetic';
if (CORPUS === 'dir' && (!CORPUS_DIR || EMBED !== 'voyage')) throw new Error('--corpus dir needs --corpus-dir DIR (voyage-4 embeddings)');
const DIMS = Number(flag('dims', EMBED === 'openai' ? '1536' : '1024'));
const CHUNKS = Number(flag('chunks', '30000'));
const QUERIES = Number(flag('queries', '100'));
const SEED = Number(flag('seed', '6132'));
const CACHE = flag('cache', join(homedir(), '.capy/work/w6/bench-cache'));
const KEEP = process.argv.includes('--keep');
const JSON_OUT = process.argv.includes('--json');
const EXPLAIN = process.argv.includes('--explain');
const NO_GRID = process.argv.includes('--no-grid');
const MODES = list('modes', LATENT ? 'relaxed_order' : 'strict_order,relaxed_order') as HnswIterativeScanMode[];
const MSTS = list('max-scan-tuples', 'shipped').map(v => (v === 'shipped' ? 'shipped' : Number(v))) as Array<'shipped' | number>;
const EFS = list('ef', LATENT ? 'shipped,40,100,200,400' : 'shipped').map(v => (v === 'shipped' ? 'shipped' : Number(v))) as Array<'shipped' | number>;
const FILTERS = list('filters', LATENT ? 'none,source10,source50,vis50,vis10' : 'source10,source50') as Group[];
// A filter may also be `source10type` / `source50type`: the same scope plus `type: 'note'`, which skips the index walk.
const KS = list('k', '10,50').map(Number);
const STATES = list('states', LATENT ? 'fresh,analyze' : '');
const BUILDS = list('builds', '');
const BUILD_FILTERS = list('build-filters', 'none,source10') as Group[];
const BUILD_EFS = list('build-ef', 'shipped,40').map(v => (v === 'shipped' ? 'shipped' : Number(v))) as Array<'shipped' | number>;
const BUILD_MWM = flag('build-mwm', '1GB');
const BUILD_PARALLEL = Number(flag('build-parallel', '0'));
const WORKERS = Number(flag('workers', String(Math.max(1, cpus().length - 2))));
const VERIFY = Number(flag('verify', LATENT ? '3' : '0'));
const REUSE_DB = flag('db', '');
const OUT = flag('out', join(homedir(), `.capy/work/hnsw-bench/${CORPUS}-${CHUNKS}`));
const LATENT_PARAMS: LatentParams = {
  ...LATENT_DEFAULTS, chunks: CHUNKS, dims: DIMS, seed: SEED,
  rank: Number(flag('latent-rank', String(LATENT_DEFAULTS.rank))),
  noise: Number(flag('latent-noise', String(LATENT_DEFAULTS.noise))),
  queryNoise: Number(flag('latent-query-noise', String(LATENT_DEFAULTS.queryNoise))),
  sourceShares: list('source-shares', LATENT_DEFAULTS.sourceShares.join(',')).map(Number) as [number, number],
};
const ROOT = join(import.meta.dir, '../..');
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('Set DATABASE_URL to a Postgres server where this role may CREATE DATABASE.');
if (!LATENT && FILTERS.some(f => f.startsWith('vis'))) throw new Error('vis filters need --corpus latent or dir');
const wallStart = performance.now();
const log = (m: string) => console.error(`[bench ${new Date().toISOString().slice(11, 19)} +${Math.round((performance.now() - wallStart) / 1000)}s] ${m}`);
mkdirSync(join(OUT, 'explain'), { recursive: true });

interface Doc { slug: string; source: string; chunks: string[] }

function corpus(): Doc[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== 'fixtures' && !name.startsWith('.')) walk(p); continue; }
      if (/\.(md|ts)$/.test(name)) files.push(p);
    }
  };
  for (const d of ['docs', 'skills', 'src', 'test']) walk(join(ROOT, d));
  const docs: Doc[] = [];
  let total = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8').replace(/\s+/g, ' ').trim();
    if (text.length < 200) continue;
    const chunks: string[] = [];
    for (let i = 0; i < text.length && chunks.length < 60; i += 800) chunks.push(text.slice(i, i + 800).replaceAll('\u0000', '').toWellFormed());
    const slug = `bench/${relative(ROOT, f).replace(/[^a-z0-9/]+/gi, '-').toLowerCase()}`;
    const h = createHash('sha256').update(slug).digest()[0]! % 10;
    docs.push({ slug, source: h === 0 ? 'bench-a' : h <= 4 ? 'bench-b' : 'bench-c', chunks });
    total += chunks.length;
    if (total >= CHUNKS) break;
  }
  return docs;
}

async function embedBatch(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
  if (EMBED === 'voyage') {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify({ model: 'voyage-4', input: texts, input_type: kind, output_dimension: DIMS }),
    });
    if (!res.ok) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map(d => d.embedding);
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts, dimensions: DIMS }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map(d => d.embedding);
}

const TILED_LATENT = 16;
function syntheticVector(text: string): number[] {
  const seed = createHash('sha256').update(text).digest();
  const latent = Array.from({ length: TILED_LATENT }, (_, i) => seed[i]! / 255 - 0.5);
  return Array.from({ length: DIMS }, (_, d) => latent[d % TILED_LATENT]! + ((seed[(d * 7) % 32]! / 255) - 0.5) * 0.05);
}

async function embedAll(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
  if (EMBED === 'synthetic') return texts.map(syntheticVector);
  mkdirSync(CACHE, { recursive: true });
  const key = createHash('sha256').update(`${EMBED}:${DIMS}:${kind}:`).update(texts.join('\u0000')).digest('hex').slice(0, 24);
  const file = join(CACHE, `${EMBED}-${DIMS}-${kind}-${key}.f32`);
  if (existsSync(file)) {
    const flat = new Float32Array(readFileSync(file).buffer.slice(0));
    return Array.from({ length: flat.length / DIMS }, (_, i) => Array.from(flat.subarray(i * DIMS, (i + 1) * DIMS)));
  }
  const out: number[][] = [];
  const batch = EMBED === 'voyage' ? 64 : 256;
  for (let i = 0; i < texts.length; i += batch) {
    for (let attempt = 0; ; attempt++) {
      try { out.push(...await embedBatch(texts.slice(i, i + batch), kind)); break; }
      catch (e) { if (attempt >= 4) throw e; log(`retry ${attempt + 1}: ${(e as Error).message}`); await Bun.sleep(2000 * (attempt + 1)); }
    }
    if ((i / batch) % 20 === 0) log(`embedded ${Math.min(i + batch, texts.length)}/${texts.length} ${kind}`);
  }
  writeFileSync(file, Buffer.from(Float32Array.from(out.flat()).buffer));
  return out;
}

// ---------------------------------------------------------------------------
// Engine seam: pin hnsw.ef_search and trace which attempts each search ran
// ---------------------------------------------------------------------------

type Run = (tx: { unsafe: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> }, sql: string, bound: unknown[]) => Promise<Record<string, unknown>[]>;
type RunAttempt = (stmt: unknown, attempt: VectorPoolAttempt, iterative: boolean, opts: SearchOpts | undefined, run: Run) => Promise<Record<string, unknown>[]>;
const seam = PostgresEngine.prototype as unknown as { runVectorAttempt: RunAttempt };
const runVectorAttempt = seam.runVectorAttempt;
let efOverride: number | undefined;
let mstOverride: number | undefined;
let trace: Array<{ walk: boolean; exact: boolean; innerLimit: number }> = [];
seam.runVectorAttempt = function (this: PostgresEngine, stmt, attempt, iterative, opts, run) {
  trace.push({ walk: !!attempt.indexWalk, exact: attempt.exact, innerLimit: attempt.innerLimit });
  return runVectorAttempt.call(this, stmt, attempt, iterative, opts, async (tx, sql, bound) => {
    // The same round trip either way, so pinned and shipped cells pay identical overhead.
    await tx.unsafe(`SELECT set_config('hnsw.ef_search', COALESCE($1, current_setting('hnsw.ef_search')), true), set_config('hnsw.max_scan_tuples', COALESCE($2, current_setting('hnsw.max_scan_tuples')), true)`,
      [efOverride === undefined ? null : String(efOverride), mstOverride === undefined ? null : String(mstOverride)]);
    return run(tx, sql, bound);
  });
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const column = { name: 'embedding', type: 'vector' as 'vector' | 'halfvec', dimensions: DIMS, embeddingModel: `bench:${CORPUS === 'latent' ? 'latent' : EMBED}` };
const dbName = REUSE_DB || `gbrain_bench_hnsw_${LATENT ? `${CORPUS}_${CHUNKS}` : 'iter'}_${randomBytes(6).toString('hex')}`;
const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'bench-stub-no-network' } });
const engine = new PostgresEngine();

interface Cell {
  state: string; build: string; filter: Group; k: number; mode: string; ef: string; maxScanTuples: string; queries: number;
  recall: number; recall10: number; recallP10: number; p50: number; p95: number; p99: number;
  short: number; incomplete: number; walk: number; pool: number; exactFallback: number; attempts: number;
}
interface Explain { state: string; build: string; filter: Group; k: number; attempt: 'walk' | 'pool' | 'pool-x4'; rpc: string; ms: number | null; annIndex: boolean; seqScanChunks: boolean; sort: boolean; jit: boolean; file: string; note?: string }
interface BuildRow { spec: string; type: string; m: number; efConstruction: number; mwm: string; parallel: number; seconds: number; bytes: number; notices: string[] }
const results = {
  corpus: CORPUS, embed: EMBED, dims: DIMS, chunks: CHUNKS, queries: QUERIES, seed: SEED, db: dbName,
  latent: CORPUS === 'latent' ? LATENT_PARAMS : undefined,
  env: {} as Record<string, unknown>, corpusStats: {} as Record<string, unknown>, stats: [] as Array<Record<string, unknown>>,
  verify: [] as Array<Record<string, unknown>>, builds: [] as BuildRow[], explain: [] as Explain[], cells: [] as Cell[], wallSeconds: 0,
  phases: {} as Record<string, number>,
};
const save = () => { results.wallSeconds = Math.round((performance.now() - wallStart) / 1000); writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2)); };
const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try { return await fn(); } finally { results.phases[name] = Math.round((performance.now() - t0) / 100) / 10; log(`${name}: ${results.phases[name]}s`); save(); }
};

/** truth[group][q] = exact top TRUTH_K page ids, best first. */
let truth: Record<string, number[][]> = {};
let queryVectors: Float32Array[] = [];
let visState: Group | null = null;

/** `<group>type` adds `type: 'note'` (every bench page's type) to a group: the same truth, but the walk is skipped. */
const truthGroup = (g: string): Group => g.replace(/type$/, '') as Group;
const filterOpts = (g: string): SearchOpts => {
  const base = truthGroup(g);
  const opts: SearchOpts = base === 'source10' ? { sourceIds: ['bench-a'] } : base === 'source50' ? { sourceIds: ['bench-a', 'bench-b'] } : base === 'vis50' || base === 'vis10' ? { excludePrivate: true } : {};
  return g.endsWith('type') ? { ...opts, type: 'note' } : opts;
};

async function exactPages(q: Float32Array, g: Group): Promise<number[]> {
  const exact = buildVectorSearchStatement({ dialect: 'postgres', embedding: q, limit: TRUTH_K, offset: 0, opts: { ...filterOpts(g), embeddingColumn: column } });
  const rows = await engine.transaction(async tx => {
    await tx.executeRaw(`SET LOCAL statement_timeout = '600s'`);
    const bound = [...exact.params];
    bound[exact.innerLimitIdx] = null;
    return tx.executeRaw<{ page_id: number | null }>(exact.exactSql, bound);
  });
  return rows.filter(r => r.page_id != null).slice(0, TRUTH_K).map(r => Number(r.page_id));
}

/** Latent only: make (100-N)% of pages private for visN; frontmatter carries each page's draw. Triggers off so no revision moves. */
async function setVisibility(g: Group, analyze: boolean): Promise<void> {
  const threshold = g === 'vis10' ? 0.1 : 0.5;
  if (visState === g) return;
  await engine.transaction(async tx => {
    await tx.executeRaw(`SET LOCAL session_replication_role = replica`);
    await tx.executeRaw(`UPDATE pages SET frontmatter = CASE WHEN (frontmatter->>'bench_vis')::float8 >= $1
        THEN (frontmatter - 'visibility') || '{"visibility":"private"}'::jsonb ELSE frontmatter - 'visibility' END
      WHERE slug LIKE 'bench/%'`, [threshold]);
  });
  if (analyze) await engine.executeRaw('VACUUM ANALYZE pages');
  visState = g;
  log(`visibility: ${g} (${Math.round((1 - threshold) * 100)}% private)`);
}

async function statsSnapshot(state: string): Promise<void> {
  const rows = await engine.executeRaw<Record<string, unknown>>(`
    SELECT c.relname, c.reltuples::bigint AS reltuples, c.relpages, c.relallvisible,
      pg_size_pretty(pg_relation_size(c.oid)) AS heap, pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
      (SELECT pg_size_pretty(pg_relation_size(c.reltoastrelid)) WHERE c.reltoastrelid <> 0) AS toast,
      (SELECT count(*) FROM pg_stats s WHERE s.tablename = c.relname)::int AS stat_columns,
      s.last_analyze, s.last_vacuum
    FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE c.relname IN ('content_chunks', 'pages', 'sources')`);
  results.stats.push({ state, tables: rows });
  log(`stats ${state}: ${rows.map(r => `${r.relname} reltuples=${r.reltuples} stat_columns=${r.stat_columns}`).join('; ')}`);
}

async function seedRepo(): Promise<void> {
  const docs = corpus();
  const chunkTexts = docs.flatMap(d => d.chunks);
  log(`corpus: ${docs.length} pages, ${chunkTexts.length} chunks; ${EMBED} @ ${DIMS} dims`);
  results.corpusStats = { pages: docs.length, chunks: chunkTexts.length };
  const vectors = await embedAll(chunkTexts, 'document');
  const rng = (() => { let s = 6132; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();
  const queryTexts = Array.from({ length: QUERIES }, () => {
    const t = chunkTexts[Math.floor(rng() * chunkTexts.length)]!;
    return (t.split(/(?<=[.!?])\s/)[0] ?? t).slice(0, 300);
  });
  queryVectors = (await embedAll(queryTexts, 'query')).map(v => Float32Array.from(v));
  let v = 0;
  for (let i = 0; i < docs.length; i += 200) {
    const slice = docs.slice(i, i + 200);
    const pageRows = await engine.executeRaw<{ id: number; slug: string }>(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
       SELECT s, src, 'note', s, 'bench', '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 4
       FROM unnest($1::text[], $2::text[]) AS t(s, src) RETURNING id, slug`, [slice.map(d => d.slug), slice.map(d => d.source)]);
    const ids = new Map(pageRows.map(r => [r.slug, Number(r.id)]));
    const pageIds: number[] = [], idx: number[] = [], texts: string[] = [], vecs: string[] = [];
    for (const d of slice) d.chunks.forEach((c, j) => { pageIds.push(ids.get(d.slug)!); idx.push(j); texts.push(c); vecs.push(JSON.stringify(vectors[v++])); });
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
      SELECT p, ci, t, 'compiled_truth', $5, md5(t), e::vector FROM unnest($1::int[], $2::int[], $3::text[], $4::text[]) AS u(p, ci, t, e)`,
      [pageIds, idx, texts, vecs, column.embeddingModel]);
  }
}

async function seedLatent(): Promise<void> {
  const params = LATENT_PARAMS;
  const plan = planPages(CHUNKS, SEED, LATENT_PARAMS.sourceShares);
  const basis = buildBasis(params);
  const q = buildQueries(params, plan, basis, QUERIES);
  queryVectors = q.vectors;
  results.corpusStats = { pages: plan.count, chunks: CHUNKS, meanChunksPerPage: Number((CHUNKS / plan.count).toFixed(2)), topics: topicCount(CHUNKS) };
  log(`latent corpus: ${plan.count} pages, ${CHUNKS} chunks, ${topicCount(CHUNKS)} topics, rank ${params.rank} @ ${DIMS} dims`);
  for (const t of ['content_chunks', 'pages', 'sources']) await engine.executeRaw(`ALTER TABLE ${t} SET (autovacuum_enabled = off, toast.autovacuum_enabled = off)`);
  const sql = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const copy = await sql.unsafe(`COPY pages (id, slug, source_id, type, title, compiled_truth, frontmatter, knowledge_revision, text_projection_revision, chunker_version) FROM STDIN`).writable();
    const finished = new Promise<void>((res, rej) => { copy.on('finish', res); copy.on('error', rej); });
    let buf = '';
    for (let p = 0; p < plan.count; p++) {
      const vis = plan.vis[p]!;
      const fm = JSON.stringify({ bench_vis: Number(vis.toFixed(6)), topic: plan.topic[p], ...(vis >= 0.5 ? { visibility: 'private' } : {}) });
      buf += `${p + 1}\t${pageSlug(p)}\t${SOURCE_IDS[plan.source[p]!]}\tnote\tLatent page ${p}\tSynthetic page ${p} on topic ${plan.topic[p]}.\t${fm}\t00000000-0000-4000-8000-000000000001\t00000000-0000-4000-8000-000000000001\t4\n`;
      if (buf.length > 1 << 20) { if (!copy.write(buf)) await new Promise(r => copy.once('drain', r)); buf = ''; }
    }
    copy.write(buf);
    copy.end();
    await finished;
    await sql.unsafe(`SELECT setval(pg_get_serial_sequence('pages', 'id'), ${plan.count})`);
  } finally { await sql.end(); }
  visState = 'vis50';
  log(`pages loaded; streaming chunks with ${WORKERS} workers`);
  const loaded = await loadLatentCorpus({ params, plan, basis, queries: q.vectors, url: url.toString(), model: column.embeddingModel, workers: WORKERS, log });
  truth = Object.fromEntries(GROUPS.map((g, gi) => [g, loaded.pages.map(per => per[gi]!.map(p => p + 1))]));
  const sorted = [...loaded.lid].sort((a, b) => a - b);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  results.corpusStats = {
    ...results.corpusStats,
    lidMedian: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(1)), lidP10: Number(sorted[Math.floor(sorted.length * 0.1)]!.toFixed(1)), lidP90: Number(sorted[Math.floor(sorted.length * 0.9)]!.toFixed(1)),
    queryTop1CosMean: Number(mean(loaded.top1Sim).toFixed(3)),
    ...geometrySample(params, plan, basis, q),
  };
  writeFileSync(join(OUT, 'truth.json'), JSON.stringify({ truth, corpusStats: results.corpusStats }));
  log(`corpus geometry: ${JSON.stringify(results.corpusStats)}`);
}

// ---------------------------------------------------------------------------
// --corpus dir: a prepared real-text corpus (scripts/bench/hnsw-real-corpus-prep.py)
// ---------------------------------------------------------------------------

interface Ledger { model: string; pricePerMTok: number; documentTokens: number; queryTokens: number; requests: number; usd: number; maxUsd: number; updatedAt: string }
const VOYAGE_4_PRICE_PER_MTOK = 0.06;

function readLedger(): Ledger {
  const file = join(CORPUS_DIR, 'ledger.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Ledger
    : { model: 'voyage:voyage-4', pricePerMTok: VOYAGE_4_PRICE_PER_MTOK, documentTokens: 0, queryTokens: 0, requests: 0, usd: 0, maxUsd: MAX_USD, updatedAt: '' };
}
function writeLedger(l: Ledger): void {
  l.usd = Number((((l.documentTokens + l.queryTokens) / 1e6) * l.pricePerMTok).toFixed(4));
  l.maxUsd = MAX_USD;
  l.updatedAt = new Date().toISOString();
  writeFileSync(join(CORPUS_DIR, 'ledger.json'), JSON.stringify(l, null, 2));
}

/** One voyage-4 call: unit-normalized vectors and the API-reported token count. Retries 429 and 5xx with backoff. */
async function voyage(texts: string[], kind: 'document' | 'query'): Promise<{ vectors: Float32Array[]; tokens: number }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify({ model: 'voyage-4', input: texts, input_type: kind, output_dimension: DIMS }),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as Response);
    if (res.ok) {
      const body = await res.json() as { data: Array<{ embedding: number[] }>; usage: { total_tokens: number } };
      const vectors = body.data.map(d => {
        const v = Float32Array.from(d.embedding);
        let n = 0;
        for (const x of v) n += x * x;
        const inv = 1 / Math.sqrt(n);
        for (let i = 0; i < v.length; i++) v[i]! *= inv;
        return v;
      });
      return { vectors, tokens: body.usage.total_tokens };
    }
    const retry = res.status === 0 || res.status === 429 || res.status >= 500;
    if (!retry || attempt >= 8) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await Bun.sleep(Math.min(60_000, 1000 * 2 ** attempt) * (0.7 + Math.random() * 0.6));
  }
}

/** Embeds chunks [have, n) into vectors.f32 in order, CONCURRENCY batches at a time; resumable and capped by --max-usd. */
async function embedCorpus(texts: Buffer, offsets: Float64Array, n: number): Promise<void> {
  const file = join(CORPUS_DIR, 'vectors.f32');
  const width = DIMS * 4;
  let have = existsSync(file) ? Math.floor(statSync(file).size / width) : 0;
  if (existsSync(file) && statSync(file).size !== have * width) truncateSync(file, have * width);
  if (have >= n) return;
  const ledger = readLedger();
  const fd = openSync(file, 'a');
  const text = (i: number) => texts.toString('utf8', offsets[i]!, offsets[i + 1]! - 1);
  const t0 = performance.now(), start = have;
  try {
    while (have < n) {
      if (ledger.usd >= MAX_USD) throw new Error(`embedding stopped at the $${MAX_USD} cap (${have}/${n} chunks, ledger.json)`);
      const batches: string[][] = [];
      let i = have;
      for (let b = 0; b < 8 && i < n; b++) {
        const batch: string[] = [];
        let chars = 0;
        while (i < n && batch.length < 128 && chars < 90_000) { const t = text(i++); batch.push(t); chars += t.length; }
        batches.push(batch);
      }
      const results = await Promise.all(batches.map(b => voyage(b, 'document')));
      for (const r of results) {
        writeSync(fd, Buffer.concat(r.vectors.map(v => Buffer.from(v.buffer, v.byteOffset, v.byteLength))));
        ledger.documentTokens += r.tokens; ledger.requests++;
      }
      have = i;
      writeLedger(ledger);
      if ((have - start) % 20_000 < 1024) log(`embedded ${have}/${n} chunks, $${ledger.usd}, ${Math.round((have - start) / ((performance.now() - t0) / 60_000))} chunks/min`);
    }
  } finally { closeSync(fd); writeLedger(ledger); }
}

/** Cached query vectors (queries.f32), or null when there are fewer than n. */
function readQueryCache(n: number): Float32Array[] | null {
  const file = join(CORPUS_DIR, 'queries.f32');
  if (!existsSync(file)) return null;
  const flat = new Float32Array(readFileSync(file).buffer.slice(0));
  if (flat.length / DIMS < n) return null;
  return Array.from({ length: n }, (_, i) => flat.slice(i * DIMS, (i + 1) * DIMS));
}

/**
 * Pages, offsets, embeddings, queries and topic-correlated sources: k-means
 * (40 clusters, cosine) over page mean vectors; whole clusters, in a seeded
 * order, fill bench-a to 10% of chunks and bench-b to 50%. Visibility stays a
 * per-page random draw, as in the latent corpus.
 */
async function seedDir(): Promise<void> {
  const lines = readFileSync(join(CORPUS_DIR, 'pages.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t'));
  const counts: number[] = [], slugs: string[] = [];
  let total = 0;
  for (const [, slug, count] of lines) { if (total >= CHUNKS) break; const c = Math.min(Number(count), CHUNKS - total); counts.push(c); slugs.push(slug!); total += c; }
  const texts = readFileSync(join(CORPUS_DIR, 'chunks.txt'));
  const offsets = new Float64Array(new SharedArrayBuffer((total + 1) * 8));
  for (let i = 0, pos = 0; i <= total; i++) { offsets[i] = pos; if (i < total) pos = texts.indexOf(10, pos) + 1; }
  log(`dir corpus: ${counts.length} pages, ${total} chunks; embedding with voyage-4 @ ${DIMS} (cap $${MAX_USD})`);
  await embedCorpus(texts, offsets, total);
  let queries = readQueryCache(QUERIES);
  if (!queries) {
    const rng = (() => { let s = SEED; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();
    const qtexts = Array.from({ length: QUERIES }, () => {
      const i = Math.floor(rng() * total);
      const t = texts.toString('utf8', offsets[i]!, offsets[i + 1]! - 1);
      const first = t.split(/(?<=[.!?])\s/)[0] ?? t;
      return (first.length >= 30 ? first : t).slice(0, 300);
    });
    const ledger = readLedger();
    const out: Float32Array[] = [];
    for (let i = 0; i < qtexts.length; i += 128) { const r = await voyage(qtexts.slice(i, i + 128), 'query'); out.push(...r.vectors); ledger.queryTokens += r.tokens; ledger.requests++; }
    writeLedger(ledger);
    writeFileSync(join(CORPUS_DIR, 'queries.f32'), Buffer.concat(out.map(v => Buffer.from(v.buffer, v.byteOffset, v.byteLength))));
    queries = out;
  }
  queryVectors = queries;
  const plan = { count: counts.length, chunkStart: new Int32Array(new SharedArrayBuffer(counts.length * 4)), chunkCount: new Int32Array(new SharedArrayBuffer(counts.length * 4)),
    topic: new Int32Array(new SharedArrayBuffer(counts.length * 4)), source: new Uint8Array(new SharedArrayBuffer(counts.length)), vis: new Float32Array(new SharedArrayBuffer(counts.length * 4)) };
  // Page mean vectors, read in one sequential pass.
  const means = new Float32Array(counts.length * DIMS);
  const fd = openSync(join(CORPUS_DIR, 'vectors.f32'), 'r');
  for (let p = 0, chunk = 0; p < counts.length; chunk += counts[p]!, p++) {
    plan.chunkStart[p] = chunk; plan.chunkCount[p] = counts[p]!;
    const buf = Buffer.allocUnsafe(counts[p]! * DIMS * 4);
    readSync(fd, buf, 0, buf.length, chunk * DIMS * 4);
    const v = new Float32Array(buf.buffer, buf.byteOffset, counts[p]! * DIMS);
    const m = means.subarray(p * DIMS, (p + 1) * DIMS);
    for (let i = 0; i < v.length; i++) m[i % DIMS]! += v[i]!;
    let norm = 0;
    for (let d = 0; d < DIMS; d++) norm += m[d]! * m[d]!;
    const inv = 1 / Math.sqrt(norm);
    for (let d = 0; d < DIMS; d++) m[d]! *= inv;
    plan.vis[p] = new Rng(hashPage(SEED, p)).next();
  }
  closeSync(fd);
  const K = 40;
  const rng = new Rng(SEED);
  const sample = Array.from({ length: Math.min(20_000, counts.length) }, () => Math.floor(rng.next() * counts.length));
  const cent = new Float32Array(K * DIMS);
  for (let k = 0; k < K; k++) cent.set(means.subarray(sample[k]! * DIMS, (sample[k]! + 1) * DIMS), k * DIMS);
  const nearest = (p: number) => {
    let best = -Infinity, arg = 0;
    for (let k = 0; k < K; k++) { let dot = 0; for (let d = 0; d < DIMS; d++) dot += means[p * DIMS + d]! * cent[k * DIMS + d]!; if (dot > best) { best = dot; arg = k; } }
    return arg;
  };
  for (let iter = 0; iter < 12; iter++) {
    const sum = new Float64Array(K * DIMS);
    for (const p of sample) { const k = nearest(p); for (let d = 0; d < DIMS; d++) sum[k * DIMS + d]! += means[p * DIMS + d]!; }
    for (let k = 0; k < K; k++) {
      let norm = 0;
      for (let d = 0; d < DIMS; d++) norm += sum[k * DIMS + d]! ** 2;
      if (norm === 0) continue;
      const inv = 1 / Math.sqrt(norm);
      for (let d = 0; d < DIMS; d++) cent[k * DIMS + d] = sum[k * DIMS + d]! * inv;
    }
  }
  const clusterChunks = new Float64Array(K);
  for (let p = 0; p < counts.length; p++) { plan.topic[p] = nearest(p); clusterChunks[plan.topic[p]!]! += counts[p]!; }
  const order = Array.from({ length: K }, (_, k) => k).sort((a, b) => hashPage(SEED, a) - hashPage(SEED, b));
  const sourceOf = new Uint8Array(K);
  let filled = 0;
  const [shareA, shareB] = LATENT_PARAMS.sourceShares;
  for (const k of order) { sourceOf[k] = filled < shareA * total ? 0 : filled < (shareA + shareB) * total ? 1 : 2; filled += clusterChunks[k]!; }
  for (let p = 0; p < counts.length; p++) plan.source[p] = sourceOf[plan.topic[p]!]!;
  const share = (s: number) => Number((Array.from(plan.source).reduce((acc, src, p) => acc + (src <= s ? counts[p]! : 0), 0) / total).toFixed(3));
  results.corpusStats = { pages: counts.length, chunks: total, meanChunksPerPage: Number((total / counts.length).toFixed(2)), topics: K, source10Share: share(0), source50Share: share(1) };
  const sql = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const copy = await sql.unsafe(`COPY pages (id, slug, source_id, type, title, compiled_truth, frontmatter, knowledge_revision, text_projection_revision, chunker_version) FROM STDIN`).writable();
    const finished = new Promise<void>((res, rej) => { copy.on('finish', res); copy.on('error', rej); });
    let buf = '';
    for (let p = 0; p < counts.length; p++) {
      const vis = plan.vis[p]!;
      const fm = JSON.stringify({ bench_vis: Number(vis.toFixed(6)), topic: plan.topic[p], ...(vis >= 0.5 ? { visibility: 'private' } : {}) });
      buf += `${p + 1}\tbench/${slugs[p]}\t${SOURCE_IDS[plan.source[p]!]}\tnote\tPage ${p}\tReal-text page ${p}.\t${fm}\t00000000-0000-4000-8000-000000000001\t00000000-0000-4000-8000-000000000001\t4\n`;
      if (buf.length > 1 << 20) { if (!copy.write(buf)) await new Promise(r => copy.once('drain', r)); buf = ''; }
    }
    copy.write(buf);
    copy.end();
    await finished;
    await sql.unsafe(`SELECT setval(pg_get_serial_sequence('pages', 'id'), ${counts.length})`);
  } finally { await sql.end(); }
  visState = 'vis50';
  for (const t of ['content_chunks', 'pages', 'sources']) await engine.executeRaw(`ALTER TABLE ${t} SET (autovacuum_enabled = off, toast.autovacuum_enabled = off)`);
  const params = { ...LATENT_PARAMS, chunks: total };
  const loaded = await loadLatentCorpus({ params, plan, basis: null, queries, url: url.toString(), model: column.embeddingModel, workers: WORKERS, log, file: { dir: CORPUS_DIR, offsets: offsets.buffer as SharedArrayBuffer } });
  truth = Object.fromEntries(GROUPS.map((g, gi) => [g, loaded.pages.map(per => per[gi]!.map(p => p + 1))]));
  const sorted = [...loaded.lid].sort((a, b) => a - b);
  results.corpusStats = {
    ...results.corpusStats,
    lidMedian: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(1)), lidP10: Number(sorted[Math.floor(sorted.length * 0.1)]!.toFixed(1)), lidP90: Number(sorted[Math.floor(sorted.length * 0.9)]!.toFixed(1)),
    queryTop1CosMean: Number((loaded.top1Sim.reduce((a, b) => a + b, 0) / loaded.top1Sim.length).toFixed(3)),
    ledger: readLedger(),
  };
  writeFileSync(join(OUT, 'truth.json'), JSON.stringify({ truth, corpusStats: results.corpusStats }));
  log(`dir corpus geometry: ${JSON.stringify(results.corpusStats)}`);
}

/** Cosine statistics of the generated vectors: random pairs, same-topic pairs, same-page pairs, query vs its source chunk. */
function geometrySample(params: LatentParams, plan: ReturnType<typeof planPages>, basis: SharedArrayBuffer, q: ReturnType<typeof buildQueries>) {
  const gen = new Generator(params, basis);
  const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
  const firstTwo = (p: number) => { const out: Float32Array[] = []; gen.page(p, Math.min(2, plan.chunkCount[p]!), (_c, v) => out.push(Float32Array.from(v))); return out; };
  const sample = Array.from({ length: Math.min(400, plan.count) }, (_, i) => Math.floor((i * 2654435761) % plan.count));
  const vecs = sample.map(firstTwo);
  let rand = 0, nRand = 0, same = 0, nSame = 0, topic = 0, nTopic = 0;
  for (let i = 0; i < vecs.length; i++) {
    if (vecs[i]!.length === 2) { same += dot(vecs[i]![0]!, vecs[i]![1]!); nSame++; }
    for (let j = i + 1; j < Math.min(vecs.length, i + 20); j++) {
      const s = dot(vecs[i]![0]!, vecs[j]![0]!);
      if (plan.topic[sample[i]!] === plan.topic[sample[j]!]) { topic += s; nTopic++; } else { rand += s; nRand++; }
    }
  }
  const byTopic = new Map<number, number[]>();
  for (let p = 0; p < plan.count && byTopic.size < 400; p++) { const t = plan.topic[p]!; const arr = byTopic.get(t) ?? []; if (arr.length < 2) arr.push(p); byTopic.set(t, arr); }
  for (const pages of byTopic.values()) if (pages.length === 2) { topic += dot(firstTwo(pages[0]!)[0]!, firstTwo(pages[1]!)[0]!); nTopic++; }
  let qs = 0;
  q.vectors.forEach((qv, i) => { gen.page(q.sourcePage[i]!, q.sourceChunk[i]! + 1, (c, v) => { if (c === q.sourceChunk[i]) qs += dot(qv, v); }); });
  const f = (x: number) => Number(x.toFixed(3));
  return { cosRandomPair: f(rand / nRand), cosSameTopic: f(topic / Math.max(1, nTopic)), cosSamePage: f(same / Math.max(1, nSame)), cosQuerySourceChunk: f(qs / q.vectors.length) };
}

async function buildIndex(spec: string, label = spec): Promise<BuildRow> {
  const [type, m, efc, ...rest] = spec.split(':');
  const opt = Object.fromEntries(rest.map(kv => kv.split('=') as [string, string]));
  const row: BuildRow = { spec: label, type: type!, m: Number(m), efConstruction: Number(efc), mwm: opt.mwm ?? BUILD_MWM, parallel: Number(opt.par ?? BUILD_PARALLEL), seconds: 0, bytes: 0, notices: [] };
  if (type !== column.type) {
    if (type !== 'halfvec' || column.type !== 'vector') throw new Error(`cannot convert ${column.type} to ${type}`);
    await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
    await phase(`convert to halfvec(${DIMS})`, async () => {
      await engine.executeRaw(`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE halfvec(${DIMS}) USING embedding::halfvec(${DIMS})`);
      await engine.executeRaw('VACUUM ANALYZE content_chunks');
    });
    column.type = 'halfvec';
  }
  const sql = postgres(url.toString(), { max: 1, prepare: false, onnotice: n => row.notices.push(String(n.message)) });
  try {
    await sql.unsafe('DROP INDEX IF EXISTS idx_chunks_embedding');
    await sql.unsafe(`SET maintenance_work_mem = '${row.mwm}'`);
    await sql.unsafe(`SET max_parallel_maintenance_workers = ${row.parallel}`);
    await sql.unsafe('SET statement_timeout = 0');
    const t0 = performance.now();
    await sql.unsafe(`CREATE INDEX CONCURRENTLY idx_chunks_embedding ON content_chunks USING hnsw (embedding ${type}_cosine_ops) WITH (m = ${row.m}, ef_construction = ${row.efConstruction})`);
    row.seconds = Math.round((performance.now() - t0) / 100) / 10;
    row.bytes = Number((await sql.unsafe(`SELECT pg_relation_size('idx_chunks_embedding') AS b`))[0]!.b);
  } finally { await sql.end(); }
  results.builds.push(row);
  log(`build ${label}: ${row.seconds}s, ${(row.bytes / 2 ** 30).toFixed(2)} GiB${row.notices.length ? `; notices: ${row.notices.join(' | ')}` : ''}`);
  save();
  return row;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

async function explain(state: string, build: string, filters: Group[]): Promise<void> {
  const [rpcRow] = await engine.executeRaw<{ v: string }>(`SELECT current_setting('random_page_cost') AS v`);
  const rpcs = [...new Set([rpcRow!.v, '4'])];
  const q = queryVectors[0]!;
  for (const g of filters) {
    if (g.startsWith('vis')) await setVisibility(g, state === 'vacuum');
    for (const k of KS) {
      const opts: SearchOpts = { ...filterOpts(g), limit: k, embeddingColumn: column, hnswIterativeScan: 'relaxed_order' };
      const stmt = buildVectorSearchStatement({ dialect: 'postgres', embedding: q, limit: k, offset: 0, opts });
      for (const attempt of [...(stmt.indexWalkSql ? ['walk'] : []), 'pool', 'pool-x4'] as Array<'walk' | 'pool' | 'pool-x4'>) {
        for (const rpc of rpcs) {
          const file = `explain/${state}-${build}-${g}-k${k}-${attempt}-rpc${rpc}.txt`;
          const run = (analyze: boolean): Run => async (tx, sql, bound) => {
            await tx.unsafe(`SELECT set_config('random_page_cost', $1, true)`, [rpc]);
            return tx.unsafe(`EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, ' : ''}SETTINGS, FORMAT TEXT) ${sql}`, bound);
          };
          const innerLimit = attempt === 'pool-x4' ? stmt.innerLimit * 4 : stmt.innerLimit;
          const go = (analyze: boolean) => runVectorAttempt.call(engine, stmt, { innerLimit, maxScanTuples: attempt === 'pool-x4' ? 8_000 : 2_000, remainingMs: 8_000, exact: false, indexWalk: attempt === 'walk' }, true, opts, run(analyze));
          let text: string, note: string | undefined;
          try { text = (await go(true)).map(r => String(r['QUERY PLAN'])).join('\n'); }
          catch (e) { note = `EXPLAIN ANALYZE failed (${(e as Error).message}); plain EXPLAIN shown`; text = (await go(false)).map(r => String(r['QUERY PLAN'])).join('\n'); }
          writeFileSync(join(OUT, file), `${note ? `-- ${note}\n` : ''}${text}\n`);
          const ms = /Execution Time: ([\d.]+) ms/.exec(text);
          const row: Explain = {
            state, build, filter: g, k, attempt, rpc, ms: ms ? Number(ms[1]) : null,
            annIndex: /Index Scan using idx_chunks_embedding/.test(text), seqScanChunks: /Seq Scan on content_chunks/.test(text),
            sort: /\n\s*->\s+(Incremental )?Sort\b/.test(text) && /Sort Key: \(?\(?cc\.embedding <=>/.test(text), jit: /JIT:/.test(text), file, ...(note ? { note } : {}),
          };
          results.explain.push(row);
          log(`explain ${state} ${g} k=${k} ${attempt} rpc=${rpc}: ${row.ms ?? '-'} ms ann=${row.annIndex} seq=${row.seqScanChunks} sort=${row.sort} jit=${row.jit}${note ? ' (timeout)' : ''}`);
        }
      }
    }
  }
  save();
}

async function grid(state: string, build: string, filters: Group[], efs: Array<'shipped' | number>, nq: number): Promise<Cell[]> {
  const cells: Cell[] = [];
  const variants = MODES.flatMap(mode => efs.flatMap(ef => (efs === EFS ? MSTS : ['shipped' as const]).map(mst => ({ mode, ef, mst }))));
  for (const g of filters) {
    if (g.startsWith('vis')) await setVisibility(truthGroup(g), state === 'vacuum');
    const tg = truthGroup(g);
    if (!truth[tg]) {
      truth[tg] = [];
      for (const q of queryVectors) truth[tg]!.push(await exactPages(q, tg));
    }
    for (const k of KS) {
      const search = async (i: number, mode: HnswIterativeScanMode, ef: 'shipped' | number, mst: 'shipped' | number = 'shipped') => {
        efOverride = ef === 'shipped' ? undefined : ef;
        mstOverride = mst === 'shipped' ? undefined : mst;
        trace = [];
        let meta: VectorPoolMeta | undefined;
        const start = performance.now();
        const hits = await engine.searchVector(queryVectors[i]!, { ...filterOpts(g), limit: k, embeddingColumn: column, hnswIterativeScan: mode, onVectorPoolMeta: m => { meta = m; } });
        const ms = performance.now() - start;
        efOverride = undefined;
        mstOverride = undefined;
        return { hits, ms, meta: meta as VectorPoolMeta | undefined, trace };
      };
      for (let i = 0; i < Math.min(5, nq); i++) for (const v of variants) await search(i, v.mode, v.ef, v.mst);
      const acc = variants.map(() => ({ ms: [] as number[], recall: [] as number[], recall10: [] as number[], short: 0, incomplete: 0, walk: 0, pool: 0, exactFallback: 0, attempts: 0 }));
      for (let i = 0; i < nq; i++) {
        const t = new Set(truth[tg]![i]!.slice(0, k));
        const t10 = new Set(truth[tg]![i]!.slice(0, 10));
        const order = variants.map((_, j) => (j + i) % variants.length);
        for (const j of order) {
          const r = await search(i, variants[j]!.mode, variants[j]!.ef, variants[j]!.mst);
          const a = acc[j]!;
          a.ms.push(r.ms);
          a.recall.push(t.size === 0 ? 1 : r.hits.slice(0, k).filter(h => t.has(h.page_id)).length / t.size);
          a.recall10.push(t10.size === 0 ? 1 : r.hits.slice(0, 10).filter(h => t10.has(h.page_id)).length / t10.size);
          if (r.hits.length < Math.min(k, t.size)) a.short++;
          if (r.meta?.underfilled) a.incomplete++;
          const last = r.trace[r.trace.length - 1];
          if (r.trace.length === 1 && last?.walk) a.walk++; else if (last && !last.exact) a.pool++;
          if (r.trace.some(x => x.exact)) a.exactFallback++;
          a.attempts += r.trace.length;
        }
      }
      variants.forEach((v, j) => {
        const a = acc[j]!;
        a.ms.sort((x, y) => x - y);
        const sortedRecall = [...a.recall].sort((x, y) => x - y);
        const pct = (p: number) => Number(a.ms[Math.min(a.ms.length - 1, Math.floor(p * a.ms.length))]!.toFixed(1));
        const cell: Cell = {
          state, build, filter: g, k, mode: v.mode, ef: String(v.ef), maxScanTuples: String(v.mst), queries: nq,
          recall: Number((a.recall.reduce((x, y) => x + y, 0) / nq).toFixed(4)), recall10: Number((a.recall10.reduce((x, y) => x + y, 0) / nq).toFixed(4)), recallP10: Number(sortedRecall[Math.floor(nq * 0.1)]!.toFixed(3)),
          p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), short: a.short / nq, incomplete: a.incomplete / nq,
          walk: a.walk / nq, pool: a.pool / nq, exactFallback: a.exactFallback / nq, attempts: Number((a.attempts / nq).toFixed(2)),
        };
        cells.push(cell); results.cells.push(cell);
        log(`${state} ${build} ${g} k=${k} ${v.mode} ef=${v.ef} mst=${v.mst}: recall ${cell.recall} p50 ${cell.p50} p95 ${cell.p95} short ${cell.short} incomplete ${cell.incomplete} walk ${cell.walk} exact ${cell.exactFallback}`);
      });
      save();
    }
  }
  return cells;
}

async function verifyTruth(filters: Group[]): Promise<void> {
  for (const g of filters) {
    if (g.startsWith('vis')) await setVisibility(g, true);
    for (let i = 0; i < Math.min(VERIFY, queryVectors.length); i++) {
      const t0 = performance.now();
      const exact = await exactPages(queryVectors[i]!, g);
      const mine = truth[g]![i]!;
      const overlap = (k: number) => exact.slice(0, k).filter(p => mine.slice(0, k).includes(p)).length / Math.min(k, exact.length);
      const row = { filter: g, query: i, overlap10: overlap(10), overlap50: overlap(50), identicalOrder: exact.join() === mine.join(), exactMs: Math.round(performance.now() - t0) };
      results.verify.push(row);
      log(`verify ${g} q${i}: ${JSON.stringify(row)}`);
    }
  }
  save();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  if (!REUSE_DB) await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await engine.connect({ database_url: url.toString(), poolSize: 2 });
  const env = (await engine.executeRaw<Record<string, unknown>>(`SELECT version() AS pg, (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector,
    current_setting('shared_buffers') AS shared_buffers, current_setting('effective_cache_size') AS effective_cache_size, current_setting('work_mem') AS work_mem,
    current_setting('random_page_cost') AS random_page_cost, current_setting('effective_io_concurrency') AS effective_io_concurrency,
    current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather, current_setting('jit') AS jit`))[0]!;
  results.env = { ...env, cpus: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30), workers: WORKERS };
  if (REUSE_DB) {
    const saved = JSON.parse(readFileSync(join(OUT, 'truth.json'), 'utf8')) as { truth: Record<string, number[][]>; corpusStats: Record<string, unknown> };
    truth = saved.truth; results.corpusStats = saved.corpusStats;
    queryVectors = CORPUS === 'dir' ? readQueryCache(QUERIES)! : buildQueries(LATENT_PARAMS, planPages(CHUNKS, SEED, LATENT_PARAMS.sourceShares), buildBasis(LATENT_PARAMS), QUERIES).vectors;
    const [fm] = await engine.executeRaw<{ n: number }>(`SELECT count(*) FILTER (WHERE frontmatter->>'visibility' = 'private')::int AS n FROM pages`);
    visState = fm!.n > Number(results.corpusStats.pages) * 0.7 ? 'vis10' : 'vis50';
    const [t] = await engine.executeRaw<{ t: string }>(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`);
    if (t!.t.startsWith('halfvec')) column.type = 'halfvec';
    log(`reusing ${dbName} (${visState}, ${t!.t})`);
  } else {
    await phase('schema', async () => {
      await engine.initSchema();
      await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
      await engine.executeRaw(`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${DIMS})`);
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('bench-a', 'bench-a'), ('bench-b', 'bench-b'), ('bench-c', 'bench-c') ON CONFLICT DO NOTHING`);
    });
    await phase('seed', () => (CORPUS === 'latent' ? seedLatent() : CORPUS === 'dir' ? seedDir() : seedRepo()));
    if (LATENT) {
      await buildIndex(`vector:16:64`, 'vector:16:64 (default)');
    } else {
      await engine.transaction(async tx => {
        await tx.executeRaw(`SET LOCAL maintenance_work_mem = '1GB'`);
        await tx.executeRaw('SET LOCAL max_parallel_maintenance_workers = 0');
        await tx.executeRaw('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
      });
    }
    const preFilters = FILTERS.filter(g => g !== 'vis10');
    for (const state of STATES) {
      if (state === 'analyze') await engine.executeRaw('ANALYZE');
      if (state === 'projection') await refreshProjectionStatistics(engine);
      await statsSnapshot(state);
      if (EXPLAIN) await phase(`explain ${state}`, () => explain(state, 'default', preFilters.filter(g => g === 'none' || g === 'source10' || g === 'vis50')));
      await phase(`grid ${state}`, () => grid(state, 'default', preFilters, ['shipped'], Math.min(50, QUERIES)));
    }
    await engine.executeRaw('VACUUM ANALYZE content_chunks');
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE sources');
    await refreshProjectionStatistics(engine);
    log('seeded and indexed');
  }
  await statsSnapshot('vacuum');
  if (VERIFY > 0 && LATENT) await phase('verify truth', () => verifyTruth(FILTERS));
  if (EXPLAIN) await phase('explain vacuum', () => explain('vacuum', 'default', FILTERS.filter(g => g === 'none' || g === 'source10' || g.startsWith('vis'))));
  const ordered = [...FILTERS.filter(g => !g.startsWith('vis')), ...FILTERS.filter(g => g === 'vis50'), ...FILTERS.filter(g => g === 'vis10')];
  if (!NO_GRID) await phase('grid vacuum', () => grid('vacuum', 'default', ordered, EFS, QUERIES));
  for (const spec of BUILDS) {
    const row = await phase(`build ${spec}`, () => buildIndex(spec));
    if (EXPLAIN) await phase(`explain ${spec}`, () => explain('vacuum', spec.replaceAll(':', '-'), BUILD_FILTERS));
    await phase(`grid ${spec}`, () => grid('vacuum', row.spec, BUILD_FILTERS, BUILD_EFS, QUERIES));
  }
} finally {
  seam.runVectorAttempt = runVectorAttempt;
  await engine.disconnect();
  if (!KEEP && !REUSE_DB) await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  save();
}

const header = `| state | build | filter | k | mode | ef_search | recall@k | recall@10 | p10 recall | p50 ms | p95 ms | short | incomplete | walk | exact fallback |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`;
const table = results.cells.map(r => `| ${r.state} | ${r.build} | ${r.filter} | ${r.k} | ${r.mode} | ${r.ef} | ${r.recall} | ${r.recall10} | ${r.recallP10} | ${r.p50} | ${r.p95} | ${r.short} | ${r.incomplete} | ${r.walk} | ${r.exactFallback} |`).join('\n');
console.log(JSON_OUT ? JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) : `${CORPUS} ${EMBED} @ ${DIMS} dims, ${JSON.stringify(results.corpusStats)}, ${QUERIES} queries, ${results.wallSeconds}s\n${header}\n${table}`);
