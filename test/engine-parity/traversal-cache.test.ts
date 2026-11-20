/**
 * BrainEngine parity — the code_traversal_cache read, write and clear, called as engine members.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite always; Postgres with DATABASE_URL) `getCodeTraversalCache` finds a row by its
 *    whole key (symbol, depth, source) at its own generation only, `putCodeTraversalCache` on an existing key replaces
 *    the response, the generation and `computed_at`, the response comes back in the key order Postgres `jsonb`
 *    prints it, and `clearCodeTraversalCache` removes one source's rows or every row and counts them.
 *  - Regression: an engine that answers a row at another generation, depth or source, that keeps the old response
 *    after a conflicting put, or that clears more or fewer rows than it counts would serve stale code traversals
 *    (code_blast, code_flow) or wipe another source's cache.
 *  - Why existing coverage misses it: test/code-intel/traversal-cache.test.ts runs on PGLite only and goes through
 *    the cache helpers, which still hold their own SQL until they call these members.
 *  - Seam: none. Real engines, typed members only. `computed_at` is wall-clock time and differs by arm, so a case
 *    compares it to its neighbours and never to a literal.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const EPOCH = new Date(0).toISOString();
const key = (symbol_qualified: string, depth = 1, source_id = 'default', cluster_generation = 0) =>
  ({ symbol_qualified, depth, source_id, cluster_generation });

describe('engine parity: code_traversal_cache members', () => {
  parityTest(
    'a cache row is found by symbol, depth, source and generation only, and a put on its key replaces the row',
    { methods: ['getCodeTraversalCache', 'putCodeTraversalCache'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'cache-other');
      await engine.putCodeTraversalCache(key('pkg.a', 1), { edges: 1 }, EPOCH, 0);
      await engine.putCodeTraversalCache(key('pkg.a', 2), { edges: 2 }, EPOCH, 0);
      await engine.putCodeTraversalCache(key('pkg.a', 1, 'cache-other'), { edges: 3 }, EPOCH, 0);
      await engine.putCodeTraversalCache(key('pkg.b', 1, 'default', 7), { edges: 4 }, EPOCH, 0);
      const found = async (k: ReturnType<typeof key>) => (await engine.getCodeTraversalCache(k))?.response_json ?? null;
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
      const firstHit = await engine.getCodeTraversalCache(key('pkg.a', 1));
      expect(firstHit?.computed_at as unknown).toBeInstanceOf(Date);
      // The put on an existing key moves it to the new generation: the old generation misses, the new one answers,
      // and the other keys stay.
      await new Promise((r) => setTimeout(r, 15));
      await engine.putCodeTraversalCache(key('pkg.a', 1, 'default', 5), { edges: 10, again: true }, EPOCH, 9);
      const replaced = await engine.getCodeTraversalCache(key('pkg.a', 1, 'default', 5));
      const after = {
        oldGeneration: await found(key('pkg.a', 1)),
        newGeneration: replaced?.response_json ?? null,
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
      return { before, after };
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
      await engine.putCodeTraversalCache(key('pkg.json'), response, EPOCH, 0);
      const hit = await engine.getCodeTraversalCache(key('pkg.json'));
      const got = hit!.response_json as Record<string, unknown>;
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
    'clearCodeTraversalCache removes one source or every source and counts the rows it removed',
    { methods: ['getCodeTraversalCache', 'putCodeTraversalCache', 'clearCodeTraversalCache'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'clear-a');
      await createSource(engine, backend, 'clear-b');
      for (const [sym, depth, source] of [
        ['s1', 1, 'clear-a'], ['s1', 2, 'clear-a'], ['s2', 1, 'clear-a'], ['s1', 1, 'clear-b'], ['s3', 1, 'default'],
      ] as const) {
        await engine.putCodeTraversalCache(key(sym, depth, source), { sym, depth, source }, EPOCH, 0);
      }
      const has = async (sym: string, depth: number, source: string) => (await engine.getCodeTraversalCache(key(sym, depth, source))) !== null;
      const left = async () => ({
        a: [await has('s1', 1, 'clear-a'), await has('s1', 2, 'clear-a'), await has('s2', 1, 'clear-a')],
        b: await has('s1', 1, 'clear-b'),
        d: await has('s3', 1, 'default'),
      });
      const start = await left();
      const clearedA = await engine.clearCodeTraversalCache({ sourceId: 'clear-a' });
      const afterA = await left();
      const clearedAgain = await engine.clearCodeTraversalCache({ sourceId: 'clear-a' });
      const clearedMissing = await engine.clearCodeTraversalCache({ sourceId: 'no-such-source' });
      // Re-put in the cleared source: the unique key is free again.
      await engine.putCodeTraversalCache(key('s1', 1, 'clear-a'), { again: true }, EPOCH, 0);
      const reput = (await engine.getCodeTraversalCache(key('s1', 1, 'clear-a')))?.response_json ?? null;
      const clearedAll = await engine.clearCodeTraversalCache({ allSources: true });
      const afterAll = await left();
      const clearedNone = await engine.clearCodeTraversalCache({ allSources: true });
      expect({ clearedA, clearedAgain, clearedMissing, clearedAll, clearedNone }).toEqual({ clearedA: 3, clearedAgain: 0, clearedMissing: 0, clearedAll: 3, clearedNone: 0 });
      expect(afterA).toEqual({ a: [false, false, false], b: true, d: true });
      expect(afterAll).toEqual({ a: [false, false, false], b: false, d: false });
      return { start, clearedA, afterA, clearedAgain, clearedMissing, reput, clearedAll, afterAll, clearedNone };
    },
  );
});
