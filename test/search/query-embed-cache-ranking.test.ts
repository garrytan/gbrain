/**
 * The gateway's per-process query-embedding cache must not change a ranking:
 * hybrid search over a fixture brain returns byte-identical result lists
 * (ids, order, scores, every field) whether each query embeds fresh or a
 * repeat is served from the cache, with and without query expansion. The fake
 * transport is a deterministic bag-of-words embedder ($0, no keys) shared by
 * the stored chunks and the queries, so the vector arm carries real signal.
 *
 * Dual backend: PGLite here; test/e2e/query-embed-cache-ranking-postgres.test.ts
 * runs the Postgres twin.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
  __clearQueryEmbedCacheForTests,
} from '../../src/core/ai/gateway.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const DIMS = 1536;
const PAGE_DATE = '2026-01-15T00:00:00Z';
const NOW = new Date('2026-03-01T00:00:00Z');
const WORDS = ['zorvane', 'kelmit', 'praxol', 'vindre', 'talquo', 'merisk', 'olbany', 'quentar', 'sulvo', 'drevik',
  'ambrel', 'coruth', 'fennal', 'gistra', 'halvor', 'ispen', 'jorvik', 'lumbra', 'nastel', 'pyrrin'];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

function bagOfWords(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261;
    for (const ch of token) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % DIMS]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

const r = rng(7);
const pick = () => WORDS[Math.floor(r() * WORDS.length)]!;
const PAGES = Array.from({ length: 120 }, (_, i) => ({
  slug: `notes/fixture-${String(i).padStart(3, '0')}`,
  title: `${pick()} ${pick()} ${i}`,
  chunks: [0, 1].map(() => Array.from({ length: 8 + Math.floor(r() * 8) }, pick).join(' ') + '.'),
}));

const QUERIES = [
  'zorvane kelmit', 'praxol', 'what did we decide about vindre and talquo', 'merisk olbany quentar',
  'sulvo drevik plan', 'ambrel', 'coruth fennal gistra halvor', 'notes on ispen from last week',
  'jorvik lumbra', 'nastel pyrrin review', 'quarterly budget review', 'kelmit zorvane',
];

const expandFn = async (q: string): Promise<string[]> => [q, `${q} notes`, q.split(' ').reverse().join(' '), 'zorvane praxol summary'];

for (const kind of testBackends()) {
  describe(`query-embed cache keeps rankings identical (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let providerCalls: string[] = [];

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      for (const page of PAGES) {
        await engine.putPage(page.slug, { type: 'note', title: page.title, compiled_truth: page.chunks.join('\n\n') });
        await installFixtureChunks(engine, page.slug, page.chunks.map((chunk_text, chunk_index) => ({
          chunk_index, chunk_text, chunk_source: 'compiled_truth', embedding: bagOfWords(chunk_text), model: 'text-embedding-3-large',
        })));
      }
      await engine.executeRaw(`UPDATE pages SET created_at = $1::timestamptz, updated_at = $1::timestamptz, effective_date = NULL`, [PAGE_DATE]);
      await engine.executeRaw('ANALYZE pages');
      await engine.executeRaw('ANALYZE content_chunks');
      setSystemTime(NOW);
    }, 180_000);

    afterAll(async () => {
      setSystemTime();
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    });

    function configure(): void {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-fake' } });
      __setEmbedTransportForTests((async (args: { values: string[] }) => {
        providerCalls.push(...args.values);
        return { embeddings: args.values.map((v) => Array.from(bagOfWords(v))) };
      }) as never);
      providerCalls = [];
    }

    async function runAll(expansion: boolean, freshEmbeds: boolean): Promise<string[]> {
      const lists: string[] = [];
      for (const round of [0, 1]) {
        for (const q of QUERIES) {
          if (freshEmbeds) __clearQueryEmbedCacheForTests();
          const results = await hybridSearch(engine, q, expansion ? { limit: 10, expansion: true, expandFn } : { limit: 10, expansion: false });
          lists.push(JSON.stringify([round, q, results]));
        }
      }
      return lists;
    }

    for (const expansion of [false, true]) {
      test(`${expansion ? 'with' : 'without'} expansion: cached and fresh embeds rank byte-identically`, async () => {
        configure();
        const fresh = await runAll(expansion, true);
        const freshCalls = providerCalls.length;
        configure();
        const cached = await runAll(expansion, false);
        const distinct = new Set(providerCalls);

        expect(cached).toEqual(fresh);
        expect(providerCalls.length).toBe(distinct.size);
        expect(providerCalls.length).toBeLessThan(freshCalls);
        expect(JSON.parse(fresh[0]!)[2].length).toBeGreaterThan(0);
        expect(fresh.some((l) => JSON.parse(l)[2].some((row: { score?: number }) => typeof row.score === 'number'))).toBe(true);
      }, 120_000);
    }
  });
}
