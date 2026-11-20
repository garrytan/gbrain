/**
 * BrainEngine parity: `gbrain cache stats`, `gbrain cache prune` and `gbrain cache clear` (src/commands/cache.ts) on
 * each engine arm, through the command body runCache runs on its connected engine (runCacheOn).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each subcommand prints the same text on PGLite, Postgres and Rust. No engine stores a query cache row
 *    while semanticResultCacheAvailable() is false, so every brain has an empty cache: stats prints the brain's cache
 *    knobs (read from its config) and zero rows, prune and clear (whole cache or one `--source`) delete zero rows.
 *  - Regression: a Rust brain that stops on a refusal for stats or prune, or a clear that answers 0 because it swallows
 *    every error, so a refused delete reads as an empty cache.
 *  - Why existing coverage misses it: test/cache-cli.test.ts and test/query-cache.test.ts run on PGLite only, where
 *    the cache statements are SQL; nothing ran the command on a Rust brain.
 *  - Seam: runCacheOn, the subcommand body after runCache connects its own engine. Console output is captured per call.
 *    Rows that a SQL brain could hold are seeded only by the PGLite tests above (the parity cases run no SQL).
 *  - Pin: the Rust store keeps no query_cache table and answers an empty cache (rust/docs/store/telemetry.md). That
 *    answer is true only while semanticResultCacheAvailable() is false, so the pin below fails when it turns true.
 */
import { describe, expect, test } from 'bun:test';
import { runCacheOn } from '../../src/commands/cache.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { STORE_MEMBERS } from '../../src/core/rust-engine/store-members/index.ts';
import { semanticResultCacheAvailable } from '../../src/core/search/query-cache.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** Runs one subcommand and returns the lines it printed to stdout and stderr. */
async function cli(engine: BrainEngine, args: string[]): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => { out.push(parts.map(String).join(' ')); };
  console.error = (...parts: unknown[]) => { err.push(parts.map(String).join(' ')); };
  try { await runCacheOn(engine, args[0]!, args); } finally { console.log = log; console.error = error; }
  return { out, err };
}

describe('engine parity: gbrain cache', () => {
  parityTest('cache stats prints the brain cache knobs and an empty cache',
    { methods: ['readQueryCacheStats'] }, async (engine) => {
      await engine.setConfig('search.cache.ttl_seconds', '120');
      await engine.setConfig('search.cache.similarity_threshold', '0.95');
      const printed = await cli(engine, ['stats']);
      expect(printed).toEqual({
        out: [
          'Semantic Query Cache stats',
          '--------------------------',
          'enabled                : false',
          'similarity_threshold   : 0.95',
          'ttl_seconds            : 120',
          '',
          'total rows             : 0',
          '  fresh                : 0',
          '  stale                : 0',
          'total hits             : 0',
        ],
        err: [],
      });
      return printed;
    });

  parityTest('cache prune deletes no row from an empty cache',
    { methods: ['pruneQueryCache'] }, async (engine) => {
      const printed = await cli(engine, ['prune']);
      expect(printed).toEqual({ out: ['Pruned 0 stale cache row(s).'], err: [] });
      return printed;
    });

  parityTest('cache clear deletes no row from an empty cache',
    { methods: ['clearQueryCache'] }, async (engine) => {
      const printed = await cli(engine, ['clear', '--yes']);
      expect(printed).toEqual({ out: ['Cleared 0 cache row(s).'], err: [] });
      return printed;
    });

  parityTest('cache clear --source deletes no row of that source and names it',
    { methods: ['clearQueryCache'] }, async (engine, backend) => {
      await createSource(engine, backend, 'side');
      const printed = await cli(engine, ['clear', '--yes', '--source', 'side']);
      expect(printed).toEqual({ out: ['Cleared 0 cache row(s) (source=side).'], err: [] });
      return printed;
    });

  // The Rust store's three cache members answer an empty cache without a table. Turning the semantic result cache on
  // makes that answer false: give the store a query_cache table (and members that read and delete it) first.
  test('the Rust store answers an empty cache only while no engine stores a cache row', () => {
    const rustCacheMembers = ['readQueryCacheStats', 'clearQueryCache', 'pruneQueryCache'].filter((m) => m in STORE_MEMBERS);
    if (semanticResultCacheAvailable()) {
      throw new Error('semanticResultCacheAvailable() is true, but the Rust store keeps no query_cache table and answers '
        + 'an empty cache. Add a store cache table first (rust/docs/store/telemetry.md).');
    }
    expect({ cacheAvailable: semanticResultCacheAvailable(), rustCacheMembers })
      .toEqual({ cacheAvailable: false, rustCacheMembers: ['readQueryCacheStats', 'clearQueryCache', 'pruneQueryCache'] });
  });
});
