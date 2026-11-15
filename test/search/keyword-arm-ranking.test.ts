/**
 * Keyword arm ranking pin, on PGLite here and on PostgreSQL through
 * test/e2e/keyword-arm-ranking-postgres.test.ts.
 *
 * Every fixture query runs through the engine's keyword arm (searchKeyword,
 * raw ts_rank scores, local and with the remote excludePrivate scope), hybrid
 * search with that remote scope, and the search, query (expand: false) and
 * recall operations without an embedding provider, so results come from the
 * keyword and title arms alone. The ranked lists (slug, chunk_id, exact
 * score and a 16-hex sha256 prefix over the chunk text and title, in order)
 * must equal test/fixtures/keyword-arm-ranking.json on both engines. It was
 * recorded before the Postgres keyword statement planned its full-text match
 * on its own for excludePrivate callers (OFFSET 0 fence): a plan change may
 * never change a row, an order or a score.
 * Regenerate with KEYWORD_RANKING_WRITE=1 only for an intended ranking change.
 *
 * It also pins how many keyword statements one search runs: one when the
 * strict (AND) query matches, two when it matches nothing and the OR fallback
 * re-runs it.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const GOLDEN = join(import.meta.dir, '..', 'fixtures', 'keyword-arm-ranking.json');
const WRITE = process.env.KEYWORD_RANKING_WRITE === '1';
// Recency decay reads the wall clock against page dates: pin both so fused scores are reproducible.
const PAGE_DATE = '2026-01-15T00:00:00Z';
const NOW = new Date('2026-03-01T00:00:00Z');

const WORDS = ['zorvane', 'kelmit', 'praxol', 'vindre', 'talquo', 'merisk', 'olbany', 'quentar', 'sulvo', 'drevik',
  'ambrel', 'coruth', 'fennal', 'gistra', 'halvor', 'ispen', 'jorvik', 'lumbra', 'nastel', 'pyrrin'];
const COMMON = 'tenmira';
const RARE = ['ostrabel', 'quillian', 'varnesh', 'yelloch'];
const TYPES = ['note', 'concept', 'meeting', 'person'];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

function fixturePages() {
  const r = rng(42);
  const pick = () => WORDS[Math.floor(r() * WORDS.length)]!;
  const sentence = (n: number) => Array.from({ length: n }, pick).join(' ');
  return Array.from({ length: 200 }, (_, i) => {
    const chunks = [0, 1].map((c) => {
      const parts = [sentence(6 + Math.floor(r() * 10))];
      if (r() < 0.45) parts.push(`${COMMON} ${sentence(3)}`);
      if (r() < 0.45) parts.push(sentence(4));
      if ((i + c) % 37 === 0) parts.push(RARE[(i + c) % RARE.length]!);
      return parts.join('. ') + '.';
    });
    return { slug: `${TYPES[i % TYPES.length]}s/fixture-${String(i).padStart(3, '0')}`, type: TYPES[i % TYPES.length]!, title: `${pick()} ${i % 9 === 0 ? COMMON : pick()} ${i}`, chunks };
  });
}

const PAGES = fixturePages();
const phrase = (p: number, at: number) => PAGES[p]!.chunks[0]!.split(/[ .]+/).slice(at, at + 3).join(' ');
const QUERIES = [
  ...[3, 17, 29, 44, 58, 71, 86, 99].map((p, i) => phrase(p, i % 3)),
  COMMON, 'kelmit', 'praxol', 'zorvane',
  ...RARE,
  'what did we decide about vindre and talquo',
  'notes on merisk olbany from last week',
  'who owns the quentar sulvo plan',
  `meeting follow ups on ${COMMON} with drevik`,
  'project planning notes',
  'quarterly budget review',
  'drevik gistra',
  'fennal halvor nastel jorvik',
];

type Ranked = Array<[string, number | null, number | null, string]>;

const sha256Prefix = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16);

/** slug, chunk_id, exact score, and the first 16 hex of a sha256 over the row's text fields (chunk text, title). */
function ranked(value: unknown): Ranked {
  const list = Array.isArray(value) ? value : ((value as { results?: unknown[] })?.results ?? []);
  return (list as Array<Record<string, unknown>>).map((row) => [
    String(row.slug),
    typeof row.chunk_id === 'number' ? row.chunk_id : null,
    typeof row.score === 'number' ? row.score : null,
    sha256Prefix(JSON.stringify([row.chunk_text ?? row.chunk ?? null, row.title ?? null])),
  ]);
}

/**
 * One golden for both engines (they must rank identically). A list equal to an
 * earlier key's list is stored as `"=<that key>"`.
 */
type Golden = Record<string, Ranked | string>;
const resolve = (g: Golden, key: string): Ranked => {
  const v = g[key];
  return typeof v === 'string' ? (g[v.slice(1)] as Ranked) : v!;
};
function serialize(lists: Record<string, Ranked>): string {
  const firstKey = new Map<string, string>();
  const lines = Object.entries(lists).map(([key, rows]) => {
    const json = JSON.stringify(rows);
    const seen = firstKey.get(json);
    if (!seen) firstKey.set(json, key);
    return `${JSON.stringify(key)}: ${seen ? JSON.stringify(`=${seen}`) : json}`;
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}
const golden: Golden = WRITE ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'));

for (const kind of testBackends()) {
  describe(`keyword arm ranking (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let ctx: OperationContext;
    const actual: Record<string, Ranked> = {};

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      for (const page of PAGES) {
        await engine.putPage(page.slug, { type: page.type, title: page.title, compiled_truth: page.chunks.join('\n\n') });
        await installFixtureChunks(engine, page.slug, page.chunks.map((chunk_text, chunk_index) => ({ chunk_index, chunk_text, chunk_source: 'compiled_truth' })));
      }
      await engine.executeRaw(`UPDATE pages SET created_at = $1::timestamptz, updated_at = $1::timestamptz, effective_date = NULL`, [PAGE_DATE]);
      await engine.executeRaw('ANALYZE pages');
      await engine.executeRaw('ANALYZE content_chunks');
      setSystemTime(NOW);
      ctx = { engine, remote: false, config: { engine: kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    }, 180_000);

    afterAll(async () => {
      if (WRITE) {
        const previous: Golden | null = (() => { try { return JSON.parse(readFileSync(GOLDEN, 'utf8')); } catch { return null; } })();
        if (previous && Object.keys(actual).some((key) => JSON.stringify(resolve(previous, key)) !== JSON.stringify(actual[key]))) {
          throw new Error(`${kind} ranks differently from the golden another engine just recorded`);
        }
        writeFileSync(GOLDEN, serialize(actual));
      }
      setSystemTime();
      await close?.();
      resetGateway();
    });

    const calls: Array<[string, (q: string) => Promise<unknown>]> = [
      ['keyword', (q) => engine.searchKeyword(q, { limit: 50, orFallback: true })],
      ['keyword-remote', (q) => engine.searchKeyword(q, { limit: 50, orFallback: true, excludePrivate: true, sourceIds: ['default'] })],
      ['search-remote', (q) => hybridSearch(engine, q, { limit: 10, expansion: false, excludePrivate: true, sourceIds: ['default'] })],
      ['search', (q) => operationsByName.search!.handler(ctx, { query: q, limit: 10 })],
      ['query', (q) => operationsByName.query!.handler(ctx, { query: q, expand: false })],
      ['recall', (q) => operationsByName.recall!.handler(ctx, { query: q, budget_tokens: 2000 })],
    ];

    for (const [op, run] of calls) {
      test(`${op}: every fixture query ranks exactly as recorded`, async () => {
        for (const q of QUERIES) {
          const key = `${op}:${q}`;
          actual[key] = ranked(await run(q));
          if (!WRITE) expect({ key, ranked: actual[key] }).toEqual({ key, ranked: resolve(golden, key) });
        }
      }, 120_000);
    }

    test('the fixture exercises strict hits, a common term and the OR fallback', () => {
      if (WRITE) return;
      const search = (q: string) => resolve(golden, `search:${q}`);
      expect(search(COMMON).length).toBe(10);
      expect(search(phrase(3, 0)).length).toBeGreaterThan(0);
      expect(search('what did we decide about vindre and talquo').length).toBeGreaterThan(0);
      expect(search('quarterly budget review')).toEqual([]);
    });

    test('one keyword statement per search, two when the strict query matches nothing', async () => {
      let statements = 0;
      const count = (sql: unknown) => { if (typeof sql === 'string' && sql.includes('ts_rank(cc.search_vector')) statements++; };
      const restore = spyKeywordStatements(engine, kind, count);
      try {
        const runs = async (q: string) => { statements = 0; await hybridSearch(engine, q, { limit: 10, expansion: false }); return statements; };
        expect(await runs(phrase(3, 0))).toBe(1);
        expect(await runs(COMMON)).toBe(1);
        expect(await runs('what did we decide about vindre and talquo')).toBe(2);
      } finally {
        restore();
      }
    });
  });
}

/** Count keyword SQL: PGLite runs it on `db.query`; Postgres on the scoped read transaction's `unsafe`. */
function spyKeywordStatements(engine: BrainEngine, kind: string, count: (sql: unknown) => void): () => void {
  const target = engine as unknown as Record<string, any>;
  if (kind === 'pglite') {
    const db = target.db;
    const original = db.query;
    db.query = function (sql: unknown, ...rest: unknown[]) { count(sql); return original.call(this, sql, ...rest); };
    return () => { db.query = original; };
  }
  const original = target.withScopedReadTransaction;
  target.withScopedReadTransaction = function (ids: unknown, id: unknown, callback: (tx: any) => unknown, opts: unknown) {
    return original.call(this, ids, id, (tx: any) => callback(new Proxy(tx, {
      get(t, prop, receiver) {
        if (prop !== 'unsafe') return Reflect.get(t, prop, receiver);
        return (sql: unknown, ...rest: unknown[]) => { count(sql); return t.unsafe(sql, ...rest); };
      },
    })), opts);
  };
  return () => { target.withScopedReadTransaction = original; };
}
