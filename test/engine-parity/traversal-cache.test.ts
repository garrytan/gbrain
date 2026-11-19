/**
 * BrainEngine parity — the code_traversal_cache read, write and clear (src/core/code-intel/traversal-cache.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite always; Postgres with DATABASE_URL; the Rust store through the napi addon)
 *    `getCachedOrCompute` computes once, writes the row and answers the second call from the cache at the same
 *    cluster generation; a row is found by its whole key (symbol, depth, source) at its own generation only; a put
 *    on an existing key replaces the response, the generation and `computed_at`; the response comes back in the
 *    order Postgres `jsonb` prints it; a bind Postgres rejects (a fractional depth, a NUL, no response) is logged
 *    and skipped, never thrown and never stored; `clearTraversalCache` removes one source's rows or every row and
 *    counts them. A generation or `xmin_max` beyond 2^53 (a whole double up to 2^63) is stored and read back exactly.
 *  - Regression: a store that answers a row at another generation, depth or source, that keeps the old response
 *    after a conflicting put, that hands the response back in write order, that stores a row Postgres refuses,
 *    or that clears more or fewer rows than it counts: a Rust brain would serve stale code traversals (code_blast,
 *    code_flow) or wipe another source's cache.
 *  - Why existing coverage misses it: test/code-intel/traversal-cache.test.ts runs on PGLite only, and the Rust arm
 *    used to refuse a generation beyond 2^53 and a `max_chunk_updated_at` with no date in it instead of answering.
 *  - Seam: none. Real engines and the production cache helpers. `computed_at` is wall-clock time and differs by arm,
 *    so a case compares it to its neighbours and never to a literal.
 */
import { describe, expect } from 'bun:test';
import {
  clearTraversalCache, getCachedOrCompute, getCachedTraversal, putCachedTraversal,
} from '../../src/core/code-intel/traversal-cache.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const EPOCH = new Date(0).toISOString();
const key = (symbol_qualified: string, depth = 1, source_id = 'default', cluster_generation = 0) =>
  ({ symbol_qualified, depth, source_id, cluster_generation });

/** Run `fn` with stderr captured; returns the lines the cache logged. */
async function logged(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { lines.push(String(s)); return true; };
  try { await fn(); } finally { process.stderr.write = write; }
  return lines.filter((l) => l.startsWith('[traversal-cache] put failed'));
}

describe('engine parity: code_traversal_cache', () => {
  parityTest(
    'getCachedOrCompute computes once and answers the next call from the cache, per key and per generation',
    { methods: ['getConfig', 'setConfig', 'getCodeTraversalCache', 'putCodeTraversalCache'] },
    async (engine) => {
      let computes = 0;
      const compute = async () => { computes += 1; return { nodes: ['a', 'b'], computes }; };
      const first = await getCachedOrCompute(engine, { symbol_qualified: 'pkg.mod.fn', depth: 2, source_id: 'default' }, compute);
      const second = await getCachedOrCompute(engine, { symbol_qualified: 'pkg.mod.fn', depth: 2, source_id: 'default' }, compute);
      const otherDepth = await getCachedOrCompute(engine, { symbol_qualified: 'pkg.mod.fn', depth: 3, source_id: 'default' }, compute);
      const afterCompute = computes;
      // A new cluster generation makes the earlier row a miss and the put replaces it in place.
      await engine.setConfig('code.cluster_generation', '4');
      const regenerated = await getCachedOrCompute(engine, { symbol_qualified: 'pkg.mod.fn', depth: 2, source_id: 'default' }, compute);
      const again = await getCachedOrCompute(engine, { symbol_qualified: 'pkg.mod.fn', depth: 2, source_id: 'default' }, compute);
      expect({ afterCompute, computes }).toEqual({ afterCompute: 2, computes: 3 });
      return { first, second, otherDepth, regenerated, again, computes };
    },
  );

  parityTest(
    'a cache row is found by symbol, depth, source and generation only, and a put on its key replaces the row',
    { methods: ['getCodeTraversalCache', 'putCodeTraversalCache'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'cache-other');
      await putCachedTraversal(engine, key('pkg.a', 1), { edges: 1 }, EPOCH, 0);
      await putCachedTraversal(engine, key('pkg.a', 2), { edges: 2 }, EPOCH, 0);
      await putCachedTraversal(engine, key('pkg.a', 1, 'cache-other'), { edges: 3 }, EPOCH, 0);
      await putCachedTraversal(engine, key('pkg.b', 1, 'default', 7), { edges: 4 }, EPOCH, 0);
      const found = async (k: ReturnType<typeof key>) => (await getCachedTraversal<{ edges: number }>(engine, k))?.response ?? null;
      const before = {
        d1: await found(key('pkg.a', 1)),
        d2: await found(key('pkg.a', 2)),
        other: await found(key('pkg.a', 1, 'cache-other')),
        wrongDepth: await found(key('pkg.a', 3)),
        wrongSource: await found(key('pkg.a', 2, 'cache-other')),
        wrongSymbol: await found(key('pkg.c', 1)),
        gen7: await found(key('pkg.b', 1, 'default', 7)),
        gen0: await found(key('pkg.b', 1)),
        gen8: await found(key('pkg.b', 1, 'default', 8)),
        caseSensitive: await found(key('PKG.A', 1)),
      };
      expect(before).toEqual({
        d1: { edges: 1 }, d2: { edges: 2 }, other: { edges: 3 }, wrongDepth: null, wrongSource: null,
        wrongSymbol: null, gen7: { edges: 4 }, gen0: null, gen8: null, caseSensitive: null,
      });
      // A lone surrogate in a text key is replaced by U+FFFD on the write and on the read, so both spellings find the row.
      await putCachedTraversal(engine, key('sur\ud800rogate', 1), { edges: 5 }, EPOCH, 0);
      const surrogate = {
        lone: await found(key('sur\ud800rogate', 1)),
        replaced: await found(key('sur\ufffdrogate', 1)),
      };
      expect(surrogate).toEqual({ lone: { edges: 5 }, replaced: { edges: 5 } });
      const firstHit = await getCachedTraversal(engine, key('pkg.a', 1));
      expect(firstHit?.computed_at).toBeInstanceOf(Date);
      // The put on an existing key moves it to the new generation: the old generation misses, the new one answers,
      // and the other keys stay.
      await new Promise((r) => setTimeout(r, 15));
      await putCachedTraversal(engine, key('pkg.a', 1, 'default', 5), { edges: 10, again: true }, EPOCH, 9);
      const replaced = await getCachedTraversal<{ edges: number; again?: boolean }>(engine, key('pkg.a', 1, 'default', 5));
      const after = {
        oldGeneration: await found(key('pkg.a', 1)),
        newGeneration: replaced?.response ?? null,
        newGenerationNumber: replaced?.cluster_generation ?? null,
        otherDepth: await found(key('pkg.a', 2)),
        otherSource: await found(key('pkg.a', 1, 'cache-other')),
      };
      expect(after).toEqual({
        oldGeneration: null, newGeneration: { edges: 10, again: true }, newGenerationNumber: 5,
        otherDepth: { edges: 2 }, otherSource: { edges: 3 },
      });
      // computed_at restarts on the conflict, so it is never earlier than the first write's.
      expect((replaced!.computed_at as unknown as Date).getTime()).toBeGreaterThan((firstHit!.computed_at as unknown as Date).getTime());
      return { before, surrogate, after };
    },
  );

  parityTest(
    'the cached response comes back in the key order and number form Postgres jsonb prints',
    { methods: ['getCodeTraversalCache', 'putCodeTraversalCache'] },
    async (engine) => {
      const response = {
        zeta: 1, b: [3, { yy: 1, x: 2, a: { bb: 1, c: 2 } }], aaa: null, é: 'unicode ✓', a: 1.5, big: 1e21, small: 1e-7,
        neg: -0, list: [[], {}, true, false, null, 'x'], '': 'empty key', Z: 'upper',
      };
      await putCachedTraversal(engine, key('pkg.json'), response, EPOCH, 0);
      const hit = await getCachedTraversal<Record<string, unknown>>(engine, key('pkg.json'));
      const got = hit!.response;
      const order = {
        top: Object.keys(got),
        nested: Object.keys((got.b as Array<unknown>)[1] as object),
        deeper: Object.keys(((got.b as Array<Record<string, unknown>>)[1]!.a) as object),
      };
      expect(order.top).toEqual(['', 'Z', 'a', 'b', 'é', 'aaa', 'big', 'neg', 'list', 'zeta', 'small']);
      expect(order.nested).toEqual(['a', 'x', 'yy']);
      expect(order.deeper).toEqual(['c', 'bb']);
      expect(got.big).toBe(1e21);
      expect(got.small).toBe(1e-7);
      expect(got.neg).toBe(0);
      return { response: got, order };
    },
  );

  parityTest(
    'a bind Postgres rejects is logged and skipped by the put, and the read of it is a miss, on every arm',
    { methods: ['getCodeTraversalCache', 'putCodeTraversalCache'] },
    async (engine) => {
      const put = (k: ReturnType<typeof key>, response: unknown, at = EPOCH, xmin = 0) =>
        logged(() => putCachedTraversal(engine, k, response, at, xmin));
      const rejected = {
        fractionalDepth: await put(key('bad.depth', 2.5), {}),
        nanDepth: await put(key('bad.nan', Number.NaN), {}),
        hugeDepth: await put(key('bad.huge', 2 ** 31), {}),
        nulSymbol: await put(key('bad\0symbol'), {}),
        nulSource: await put(key('bad.source', 1, 'a\0b'), {}),
        noResponse: await put(key('bad.undefined'), undefined),
        nulInResponse: await put(key('bad.nul'), { s: 'a\0b' }),
        loneSurrogate: await put(key('bad.surrogate'), { s: '\ud800' }),
        notADate: await put(key('bad.date'), {}, 'not a date'),
        fractionalXmin: await put(key('bad.xmin'), {}, EPOCH, 1.5),
        hugeXmin: await put(key('bad.hugexmin'), {}, EPOCH, 1e21),
      };
      expect(Object.fromEntries(Object.entries(rejected).map(([k, v]) => [k, v.length]))).toEqual(
        Object.fromEntries(Object.keys(rejected).map((k) => [k, 1])),
      );
      const stored = {
        fractionalDepth: await getCachedTraversal(engine, key('bad.depth', 2.5)),
        nanDepth: await getCachedTraversal(engine, key('bad.nan', Number.NaN)),
        hugeDepth: await getCachedTraversal(engine, key('bad.huge', 2 ** 31)),
        nulSymbol: await getCachedTraversal(engine, key('bad\0symbol')),
        wholeSymbol: await getCachedTraversal(engine, key('bad')),
        noResponse: await getCachedTraversal(engine, key('bad.undefined')),
        nulInResponse: await getCachedTraversal(engine, key('bad.nul')),
        loneSurrogate: await getCachedTraversal(engine, key('bad.surrogate')),
        notADate: await getCachedTraversal(engine, key('bad.date')),
        fractionalXmin: await getCachedTraversal(engine, key('bad.xmin')),
        hugeXmin: await getCachedTraversal(engine, key('bad.hugexmin')),
      };
      expect(Object.values(stored).every((v) => v === null)).toBe(true);
      // The cache keeps working after the refusals: whole numbers, a signed zero depth and a loose xmin are fine.
      await putCachedTraversal(engine, key('good', -0), { ok: 1 }, EPOCH, 2 ** 40);
      const good = await getCachedTraversal<{ ok: number }>(engine, key('good', 0));
      expect(good?.response).toEqual({ ok: 1 });
      return { rejected: Object.fromEntries(Object.entries(rejected).map(([k, v]) => [k, v.length])), stored, good: good?.response };
    },
  );

  parityTest(
    'the three members answer a miss with null, a put with nothing, and a clear with the number of rows it removed',
    { methods: ['getCodeTraversalCache', 'putCodeTraversalCache', 'clearCodeTraversalCache'] },
    async (engine) => {
      const k = key('pkg.direct', 3, 'default', 12);
      const miss = await engine.getCodeTraversalCache(k);
      const put = await engine.putCodeTraversalCache(k, { nodes: [1, 2] }, EPOCH, 0);
      const hit = await engine.getCodeTraversalCache(k);
      const cleared = await engine.clearCodeTraversalCache({ sourceId: 'default' });
      const afterClear = await engine.getCodeTraversalCache(k);
      const nothingToClear = await engine.clearCodeTraversalCache({ allSources: true });
      expect(miss).toBeNull();
      expect(put).toBeUndefined();
      expect(Object.keys(hit!).sort()).toEqual(['cluster_generation', 'computed_at', 'response_json']);
      expect(typeof hit!.cluster_generation).toBe('number');
      expect(hit!.computed_at as unknown).toBeInstanceOf(Date);
      expect({ cleared, afterClear, nothingToClear }).toEqual({ cleared: 1, afterClear: null, nothingToClear: 0 });
      return { miss, put, response: hit!.response_json, generation: hit!.cluster_generation, cleared, afterClear, nothingToClear };
    },
  );

  parityTest(
    'clearTraversalCache removes one source or every source and counts the rows it removed',
    { methods: ['getCodeTraversalCache', 'putCodeTraversalCache', 'clearCodeTraversalCache'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'clear-a');
      await createSource(engine, backend, 'clear-b');
      for (const [sym, depth, source] of [
        ['s1', 1, 'clear-a'], ['s1', 2, 'clear-a'], ['s2', 1, 'clear-a'], ['s1', 1, 'clear-b'], ['s3', 1, 'default'],
      ] as const) {
        await putCachedTraversal(engine, key(sym, depth, source), { sym, depth, source }, EPOCH, 0);
      }
      const left = async () => ({
        a: [(await getCachedTraversal(engine, key('s1', 1, 'clear-a'))) !== null, (await getCachedTraversal(engine, key('s1', 2, 'clear-a'))) !== null, (await getCachedTraversal(engine, key('s2', 1, 'clear-a'))) !== null],
        b: (await getCachedTraversal(engine, key('s1', 1, 'clear-b'))) !== null,
        d: (await getCachedTraversal(engine, key('s3', 1, 'default'))) !== null,
      });
      const start = await left();
      const clearedA = await clearTraversalCache(engine, { sourceId: 'clear-a' });
      const afterA = await left();
      const clearedAgain = await clearTraversalCache(engine, { sourceId: 'clear-a' });
      const clearedMissing = await clearTraversalCache(engine, { sourceId: 'no-such-source' });
      // Re-put in the cleared source: the unique key is free again.
      await putCachedTraversal(engine, key('s1', 1, 'clear-a'), { again: true }, EPOCH, 0);
      const reput = (await getCachedTraversal(engine, key('s1', 1, 'clear-a')))?.response ?? null;
      const clearedAll = await clearTraversalCache(engine, { allSources: true });
      const afterAll = await left();
      const clearedNone = await clearTraversalCache(engine, { allSources: true });
      let neither = '';
      try { await clearTraversalCache(engine, {}); } catch (e) { neither = (e as Error).message.split('.')[0]!; }
      expect({ clearedA, clearedAgain, clearedMissing, clearedAll, clearedNone }).toEqual({ clearedA: 3, clearedAgain: 0, clearedMissing: 0, clearedAll: 3, clearedNone: 0 });
      expect(afterA).toEqual({ a: [false, false, false], b: true, d: true });
      expect(afterAll).toEqual({ a: [false, false, false], b: false, d: false });
      return { start, clearedA, afterA, clearedAgain, clearedMissing, reput, clearedAll, afterAll, clearedNone, neither };
    },
  );

  parityTest(
    'a generation or xmin beyond 2^53 is stored and read back exactly on every arm',
    { methods: ['getCodeTraversalCache', 'putCodeTraversalCache'] },
    async (engine) => {
      const put = await logged(() => putCachedTraversal(engine, key('huge.generation', 1, 'default', 2 ** 60), { ok: 1 }, EPOCH, 2 ** 60));
      expect(put).toEqual([]);
      const hit = await getCachedTraversal<{ ok: number }>(engine, key('huge.generation', 1, 'default', 2 ** 60));
      const miss = await getCachedTraversal(engine, key('huge.generation', 1, 'default', 0));
      expect({ response: hit?.response ?? null, generation: hit?.cluster_generation ?? null }).toEqual({ response: { ok: 1 }, generation: 2 ** 60 });
      return { response: hit?.response ?? null, generation: hit?.cluster_generation ?? null, miss };
    },
  );
});
