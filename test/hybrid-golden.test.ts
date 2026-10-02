/**
 * Refactor wave 1 (W0, A13): deterministic hybrid-search golden.
 *
 * Pins the exact ranked output — (source, slug, page id, chunk id, chunk
 * index, score) — of `hybridSearch` and of `hybridSearchCached` (cold, then
 * warm on the same queries) over a seeded PGLite corpus. The W4 hybrid stage
 * decomposition must reproduce it byte for byte.
 *
 * Determinism:
 *   - embeddings: a hash bag-of-words embedder (FNV-1a token buckets, fixed
 *     dims, L2-normalized) used both for stored chunk vectors and, through
 *     the `queryEmbedFn` seam, for query vectors — no gateway, no provider;
 *   - corpus: 48 generic pages across two sources, 1–3 chunks each, links for
 *     the backlink stage, and fixed effective dates for the recency stage;
 *   - clock: `setSystemTime` pins Date.now() so the one temporal query's
 *     recency boost is exact;
 *   - config: fresh brain defaults (search mode resolved from an empty config).
 *   - network: `fetch` is replaced for the file's lifetime and must never be
 *     called (no paid provider — embedding, expansion or reranker — is reached).
 *
 * Normalizer `hybrid-ranked-v1`: identity. Scores are pinned as exact JSON
 * numbers; two independent captures in this process must be identical
 * (expectNormalizerStable), and so are cold vs warm cached captures.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch, hybridSearchCached, awaitPendingSearchCacheWrites } from '../src/core/search/hybrid.ts';
import { fnv1a } from '../src/eval/deterministic-embed.ts';
import type { HybridSearchOpts } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';

const DIM = 1536;
const PINNED_NOW = new Date('2026-06-15T12:00:00.000Z');

/** Hash bag-of-words: each lowercase letter/number run adds ±1 to one bucket. */
function hashEmbed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (const tok of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const h = fnv1a(tok);
    v[Math.abs(h) % DIM] += (h & 1) === 0 ? 1 : -1;
    const h2 = fnv1a(`${tok}#2`);
    v[Math.abs(h2) % DIM] += 0.5;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

const TOPICS = [
  { key: 'widget', words: 'widget calibration torque assembly line sensor tolerance' },
  { key: 'garden', words: 'garden shade plants soil compost watering seedlings growth' },
  { key: 'quantum', words: 'quantum sensor qubit coherence cryogenic measurement noise' },
  { key: 'recipe', words: 'recipe bread flour yeast oven proofing crust baking' },
  { key: 'roadmap', words: 'roadmap planning quarter milestone launch widget release' },
  { key: 'graph', words: 'knowledge graph entity link backlink traversal ranking' },
];
const TYPES = ['note', 'concept', 'person', 'company'] as const;
const SOURCES = ['default', 'team-example'] as const;

interface SeedPage {
  slug: string;
  sourceId: string;
  type: string;
  title: string;
  chunks: string[];
  date: string;
}

function corpus(): SeedPage[] {
  const pages: SeedPage[] = [];
  for (let i = 0; i < 44; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const other = TOPICS[(i * 5 + 1) % TOPICS.length];
    const type = TYPES[i % TYPES.length];
    const sourceId = SOURCES[i % 3 === 2 ? 1 : 0];
    const n = 1 + (i % 3);
    const chunks: string[] = [];
    for (let c = 0; c < n; c++) {
      const words = topic.words.split(' ');
      const pick = words.filter((_, w) => (w + c + i) % 2 === 0).join(' ');
      chunks.push(`${topic.key} page ${i} part ${c}: ${pick}. Mentions ${other.key} ${other.words.split(' ')[c % 7]}.`);
    }
    const slugPrefix = type === 'person' ? 'people' : type === 'company' ? 'companies' : type === 'concept' ? 'concepts' : 'notes';
    pages.push({
      slug: `${slugPrefix}/${topic.key}-example-${i}`,
      sourceId,
      type,
      title: `${topic.key[0].toUpperCase()}${topic.key.slice(1)} Example ${i}`,
      chunks,
      date: new Date(Date.UTC(2025, i % 12, 1 + (i % 27))).toISOString().slice(0, 10),
    });
  }
  pages.push(
    { slug: 'people/alice-example', sourceId: 'default', type: 'person', title: 'Alice Example', chunks: ['Alice Example leads the widget roadmap at Acme Example.', 'Alice Example partnered with Acme Example on quantum sensor calibration.'], date: '2026-05-01' },
    { slug: 'companies/acme-example', sourceId: 'default', type: 'company', title: 'Acme Example', chunks: ['Acme Example builds widget assembly lines and quantum sensor rigs.'], date: '2026-04-01' },
    { slug: 'notes/garden-news-latest', sourceId: 'default', type: 'note', title: 'Garden News', chunks: ['Latest garden news: shade plants and compost updates this week.'], date: '2026-06-10' },
    { slug: 'notes/garden-news-archive', sourceId: 'default', type: 'note', title: 'Garden News Archive', chunks: ['Garden news archive: shade plants and compost from long ago.'], date: '2021-06-10' },
    { slug: 'concepts/knowledge-graph-zh', sourceId: 'default', type: 'concept', title: '知识图谱', chunks: ['知识图谱 是 实体 与 链接 的 网络。知识图谱 支持 排名。'], date: '2026-02-02' },
    { slug: 'concepts/knowledge-graph-zh-team', sourceId: 'team-example', type: 'concept', title: '知识图谱 团队', chunks: ['团队 知识图谱 笔记：实体 链接 反向链接。'], date: '2026-03-03' },
  );
  return pages;
}

const QUERIES: Array<{ id: string; q: string; opts?: HybridSearchOpts }> = [
  { id: 'keyword-heavy', q: 'widget calibration torque' },
  { id: 'semantic', q: 'how do seedlings grow in shade soil' },
  { id: 'mixed-entities', q: 'Alice Example Acme Example quantum partnership' },
  { id: 'title-exact', q: 'Acme Example' },
  { id: 'temporal-recency', q: 'latest garden news' },
  { id: 'cjk', q: '知识图谱' },
  { id: 'source-filter', q: 'graph backlink traversal', opts: { sourceId: 'team-example' } },
  { id: 'multi-source-limit', q: 'quantum sensor noise', opts: { sourceIds: ['default', 'team-example'], limit: 5 } },
];

type Ranked = Array<{ source_id: string | undefined; slug: string; page_id: number; chunk_id: number; chunk_index: number; score: number }>;
type Capture = Record<string, { hybrid: Ranked; cached_cold: Ranked; cached_warm: Ranked }>;

const HYBRID = defineNormalizer<Capture>('hybrid-ranked-v1', (c) => c);

function ranked(results: SearchResult[]): Ranked {
  return results.map((r) => ({
    source_id: r.source_id,
    slug: r.slug,
    page_id: r.page_id,
    chunk_id: r.chunk_id,
    chunk_index: r.chunk_index,
    score: r.score,
  }));
}

let engine: PGLiteEngine;
const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String((input as { url?: string })?.url ?? input));
    throw new Error('hybrid-golden: network disabled');
  }) as unknown as typeof fetch;
  setSystemTime(PINNED_NOW);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team-example', 'team-example') ON CONFLICT (id) DO NOTHING`);
  const pages = corpus();
  for (const p of pages) {
    await engine.putPage(p.slug, { type: p.type as never, title: p.title, compiled_truth: p.chunks.join('\n\n') }, { sourceId: p.sourceId });
    await installFixtureChunks(
      engine,
      p.slug,
      p.chunks.map((text, chunk_index) => ({ chunk_index, chunk_text: text, chunk_source: 'compiled_truth' as const, embedding: hashEmbed(text), token_count: text.split(/\s+/).length })),
      { sourceId: p.sourceId },
    );
    await engine.executeRaw(`UPDATE pages SET effective_date = $1::date, updated_at = $1::timestamptz, created_at = $1::timestamptz WHERE slug = $2 AND source_id = $3`, [p.date, p.slug, p.sourceId]);
  }
  const hub = pages.filter((p) => p.sourceId === 'default');
  for (let i = 0; i < hub.length; i += 3) {
    await engine.addLink(hub[i].slug, 'companies/acme-example', 'mentions', 'mentions');
    await engine.addLink(hub[i].slug, 'people/alice-example', 'mentions', 'mentions');
  }
}, 120_000);

afterAll(async () => {
  setSystemTime();
  globalThis.fetch = realFetch;
  await engine.disconnect();
});

async function captureAll(): Promise<Capture> {
  const out: Capture = {};
  for (const { id, q, opts } of QUERIES) {
    const o: HybridSearchOpts = { ...opts, queryEmbedFn: hashEmbed };
    const hybrid = ranked(await hybridSearch(engine, q, o));
    const cachedCold = ranked(await hybridSearchCached(engine, q, o));
    await awaitPendingSearchCacheWrites();
    out[id] = { hybrid, cached_cold: cachedCold, cached_warm: [] };
  }
  for (const { id, q, opts } of QUERIES) {
    out[id].cached_warm = ranked(await hybridSearchCached(engine, q, { ...opts, queryEmbedFn: hashEmbed }));
  }
  return out;
}

describe('hybrid search golden (A13)', () => {
  test('stored vectors use the stub embedder width', async () => {
    const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL`);
    expect(Number(rows[0].n)).toBeGreaterThan(48);
    expect(Date.now()).toBe(PINNED_NOW.getTime());
  });

  test('hybridSearch + hybridSearchCached (cold, warm) ranked output matches the golden', async () => {
    const capture = await expectNormalizerStable(captureAll, HYBRID);
    for (const { id } of QUERIES) {
      expect(capture[id].hybrid.length).toBeGreaterThan(0);
      expect(capture[id].cached_cold).toEqual(capture[id].hybrid);
      expect(capture[id].cached_warm).toEqual(capture[id].hybrid);
    }
    expect(fetchCalls).toEqual([]);
    expectGolden('hybrid/ranked-results', capture, HYBRID);
  }, 120_000);
});
