/**
 * BrainEngine parity — the code_traversal_cache read and write (src/core/code-intel/traversal-cache.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on the SQL arms (PGLite always; Postgres with DATABASE_URL) `getCachedOrCompute` computes once, writes
 *    the row, and answers the second call from the cache at the same cluster generation; `putCachedTraversal` then
 *    `getCachedTraversal` round-trips the response. The cache runs on raw SQL, so every case declares
 *    `requires: 'raw_sql'`: the Rust arm must stop on the typed `engine_capability_missing` refusal (reason
 *    `raw_sql`) from both the read and the write, never a silent miss.
 *  - Regression: a cache read that swallows the Rust refusal as a miss, or a write that logs it and returns, so a
 *    Rust brain recomputes every traversal while looking healthy (ruling C: refuse loudly until the store serves the
 *    cache).
 *  - Why existing coverage misses it: test/code-intel/traversal-cache.test.ts runs on PGLite only, where raw SQL works.
 *  - Seam: none. Real engines and the production cache helpers.
 */
import { describe, expect } from 'bun:test';
import { getCachedOrCompute, getCachedTraversal, putCachedTraversal } from '../../src/core/code-intel/traversal-cache.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: code_traversal_cache', () => {
  parityTest(
    'getCachedOrCompute computes once and answers the next call from the cache; Rust refuses the read loudly',
    { methods: ['getConfig', 'executeRaw'], requires: 'raw_sql' },
    async (engine) => {
      let computes = 0;
      const key = { symbol_qualified: 'pkg.mod.fn', depth: 2, source_id: 'default' };
      const compute = async () => { computes += 1; return { nodes: ['a', 'b'], computes }; };
      const first = await getCachedOrCompute(engine, key, compute);
      const second = await getCachedOrCompute(engine, key, compute);
      expect(computes).toBe(1);
      return { first, second, computes };
    },
  );

  parityTest(
    'putCachedTraversal then getCachedTraversal round-trips the response; Rust refuses the write loudly',
    { methods: ['executeRaw'], requires: 'raw_sql' },
    async (engine) => {
      const key = { symbol_qualified: 'pkg.mod.other', depth: 1, source_id: 'default', cluster_generation: 0 };
      await putCachedTraversal(engine, key, { edges: 3 }, new Date(0).toISOString(), 0);
      const hit = await getCachedTraversal<{ edges: number }>(engine, key);
      const otherGeneration = await getCachedTraversal(engine, { ...key, cluster_generation: 1 });
      return { response: hit?.response ?? null, generation: hit?.cluster_generation ?? null, otherGeneration };
    },
  );
});
