#!/usr/bin/env bun
/**
 * #6132 bench: pgvector `hnsw.iterative_scan` strict_order vs relaxed_order on
 * filtered vector search. Opt-in, never run in CI, not shipped in the CLI.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
 *     bun scripts/bench/hnsw-iterative-scan.ts --dims 1024 [--chunks 30000]
 *       [--queries 100] [--embed voyage|openai|synthetic] [--cache DIR] [--json] [--keep]
 *
 * Creates `gbrain_bench_hnsw_iter_<hex>` on the DATABASE_URL server (the role
 * needs CREATEDB and CREATE EXTENSION vector), seeds one page per corpus
 * document (chunks of up to 800 characters, at most 60 per page) from this
 * repository's docs/, skills/, src/ and test/ text (fixtures excluded), spread over three sources by a
 * slug hash (10% / 40% / 50%), embeds the chunks for real (`--embed voyage`:
 * voyage-4 at 1024 dims; `--embed openai`: text-embedding-3-small at 1536
 * dims; `synthetic`: a 16-dim latent tiled across the dimensions, no network),
 * builds the HNSW index and ANALYZEs. Queries are the first sentence of
 * randomly chosen chunks, embedded as queries. Embeddings are cached under
 * `--cache` (default ~/.capy/work/w6/bench-cache) so reruns cost nothing.
 *
 * For each filter selectivity (10%: one source; 50%: two sources) and each k
 * (10, 50), both modes run the same queries through PostgresEngine.searchVector
 * and report recall@k of pages against an exact max-pooled scan with the same
 * filter, p50 and p95 latency, and underfilled exits. A warm-up pass runs
 * first; modes alternate per query so cache warmth is shared. Drops the
 * database unless --keep.
 */
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { refreshProjectionStatistics } from '../../src/core/search/projection-statistics.ts';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import type { HnswIterativeScanMode } from '../../src/core/search/hnsw-iterative-scan.ts';
import type { SearchOpts } from '../../src/core/types.ts';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const EMBED = flag('embed', 'voyage') as 'voyage' | 'openai' | 'synthetic';
const DIMS = Number(flag('dims', EMBED === 'openai' ? '1536' : '1024'));
const CHUNKS = Number(flag('chunks', '30000'));
const QUERIES = Number(flag('queries', '100'));
const CACHE = flag('cache', join(homedir(), '.capy/work/w6/bench-cache'));
const KEEP = process.argv.includes('--keep');
const JSON_OUT = process.argv.includes('--json');
const MODES: HnswIterativeScanMode[] = ['strict_order', 'relaxed_order'];
const ROOT = join(import.meta.dir, '../..');
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('Set DATABASE_URL to a Postgres server where this role may CREATE DATABASE.');
const log = (m: string) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${m}`);

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

const LATENT = 16;
function syntheticVector(text: string): number[] {
  const seed = createHash('sha256').update(text).digest();
  const latent = Array.from({ length: LATENT }, (_, i) => seed[i]! / 255 - 0.5);
  return Array.from({ length: DIMS }, (_, d) => latent[d % LATENT]! + ((seed[(d * 7) % 32]! / 255) - 0.5) * 0.05);
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

const docs = corpus();
const chunkTexts = docs.flatMap(d => d.chunks);
log(`corpus: ${docs.length} pages, ${chunkTexts.length} chunks; ${EMBED} @ ${DIMS} dims`);
const vectors = await embedAll(chunkTexts, 'document');
const rng = (() => { let s = 6132; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();
const queryTexts = Array.from({ length: QUERIES }, () => {
  const t = chunkTexts[Math.floor(rng() * chunkTexts.length)]!;
  return (t.split(/(?<=[.!?])\s/)[0] ?? t).slice(0, 300);
});
const queryVectors = (await embedAll(queryTexts, 'query')).map(v => Float32Array.from(v));

const column = { name: 'embedding', type: 'vector' as const, dimensions: DIMS, embeddingModel: `bench:${EMBED}` };
const dbName = `gbrain_bench_hnsw_iter_${randomBytes(6).toString('hex')}`;
const admin = postgres(adminUrl, { max: 1, prepare: false });
await admin.unsafe(`CREATE DATABASE ${dbName}`);
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'bench-stub-no-network' } });
const engine = new PostgresEngine();
await engine.connect({ database_url: url.toString(), poolSize: 2 });

type Row = { selectivity: string; k: number; mode: string; recall: number; p50: number; p95: number; underfilled: number };
const results: Row[] = [];
try {
  await engine.initSchema();
  await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
  await engine.executeRaw(`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${DIMS})`);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('bench-a', 'bench-a'), ('bench-b', 'bench-b'), ('bench-c', 'bench-c') ON CONFLICT DO NOTHING`);
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
  await engine.transaction(async tx => {
    await tx.executeRaw(`SET LOCAL maintenance_work_mem = '1GB'`);
    await tx.executeRaw('SET LOCAL max_parallel_maintenance_workers = 0');
    await tx.executeRaw('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
  });
  await engine.executeRaw('VACUUM ANALYZE content_chunks');
  await engine.executeRaw('ANALYZE pages');
  await engine.executeRaw('ANALYZE sources');
  await refreshProjectionStatistics(engine);
  log('seeded and indexed');

  const filters: Array<[string, SearchOpts]> = [['10%', { sourceIds: ['bench-a'] }], ['50%', { sourceIds: ['bench-a', 'bench-b'] }]];
  for (const [selectivity, filter] of filters) {
    for (const k of [10, 50]) {
      const truth: Array<Set<number>> = [];
      for (const q of queryVectors) {
        const exact = buildVectorSearchStatement({ dialect: 'postgres', embedding: q, limit: k, offset: 0, opts: { ...filter, embeddingColumn: column } });
        const rows = await engine.transaction(async tx => {
          await tx.executeRaw(`SET LOCAL statement_timeout = '120s'`);
          const bound = [...exact.params];
          bound[exact.innerLimitIdx] = null;
          return tx.executeRaw<{ page_id: number | null }>(exact.exactSql, bound);
        });
        truth.push(new Set(rows.filter(r => r.page_id != null).slice(0, k).map(r => Number(r.page_id))));
      }
      for (const q of queryVectors.slice(0, 5)) for (const mode of MODES) await engine.searchVector(q, { ...filter, limit: k, embeddingColumn: column, hnswIterativeScan: mode });
      const acc = new Map(MODES.map(m => [m, { ms: [] as number[], recall: 0, underfilled: 0 }]));
      for (let i = 0; i < queryVectors.length; i++) {
        for (const mode of i % 2 === 0 ? MODES : [...MODES].reverse()) {
          const a = acc.get(mode)!;
          const start = performance.now();
          const hits = await engine.searchVector(queryVectors[i]!, { ...filter, limit: k, embeddingColumn: column, hnswIterativeScan: mode,
            onVectorPoolMeta: m => { if (m.underfilled) a.underfilled++; } });
          a.ms.push(performance.now() - start);
          const t = truth[i]!;
          a.recall += t.size === 0 ? 1 : hits.slice(0, k).filter(h => t.has(h.page_id)).length / t.size;
        }
      }
      for (const mode of MODES) {
        const a = acc.get(mode)!;
        a.ms.sort((x, y) => x - y);
        const pct = (p: number) => Number(a.ms[Math.min(a.ms.length - 1, Math.floor(p * a.ms.length))]!.toFixed(1));
        results.push({ selectivity, k, mode, recall: Number((a.recall / queryVectors.length).toFixed(3)), p50: pct(0.5), p95: pct(0.95), underfilled: a.underfilled });
        log(JSON.stringify(results.at(-1)));
      }
    }
  }
} finally {
  await engine.disconnect();
  if (!KEEP) await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
}

const header = `| selectivity | k | mode | recall@k | p50 ms | p95 ms | underfilled |\n|---|---|---|---|---|---|---|`;
const table = results.map(r => `| ${r.selectivity} | ${r.k} | ${r.mode} | ${r.recall} | ${r.p50} | ${r.p95} | ${r.underfilled} |`).join('\n');
console.log(JSON_OUT ? JSON.stringify({ embed: EMBED, dims: DIMS, pages: docs.length, chunks: chunkTexts.length, queries: QUERIES, results }, null, 2) : `${EMBED} @ ${DIMS} dims, ${docs.length} pages, ${chunkTexts.length} chunks, ${QUERIES} queries\n${header}\n${table}`);
