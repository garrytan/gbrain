/**
 * BrainEngine parity: `listRecentPurgeRequests`, which the purge-mirror doctor check reads through
 * engine-sql/doctor-persistence.ts and which a Rust brain used to answer empty even with purges in the store.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the request ids of the recent page purges (distinct, rows with no request skipped, capped) are the same
 *    on every engine arm. Rows are seeded through the harness fixture `recordPagePurge`: the `page_purges` writer on
 *    PGLite/Postgres, the store's own ledger on the Rust arm.
 *  - Regression: a Rust brain answering `[]` made the purge-mirror check report no purge to mirror, where PGLite listed
 *    the requests and warned about the ones with no mirror receipt.
 *  - Why existing coverage misses it: doctor-persistence.test.ts reads the empty brain only.
 *  - Seam: none beyond the fixture. The window's edge needs a clock the arms do not share; the store's own test
 *    (rust/crates/gbrain-store/tests/facts_page_purges.rs) pins it.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, recordPagePurge } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const A = '0a000000-0000-4000-8000-00000000000a';
const B = '0b000000-0000-4000-8000-00000000000b';
const C = '0c000000-0000-4000-8000-00000000000c';

describe('page purge requests', () => {
  parityTest(
    'listRecentPurgeRequests lists each recent request id once, skips purges with no request, and honours the cap',
    { methods: ['listRecentPurgeRequests'] },
    async (engine, backend) => {
      const empty = await engine.listRecentPurgeRequests(30, 100);
      await createSource(engine, backend, 'wiki');
      await recordPagePurge(engine, backend, 'default', ['h1', 'h2'], 'notes/a', A);
      await recordPagePurge(engine, backend, 'wiki', ['h1'], 'notes/b', B);
      await recordPagePurge(engine, backend, 'wiki', ['h3'], 'notes/c', C);
      await recordPagePurge(engine, backend, 'wiki', ['h4'], 'notes/d', null);
      const all = (await engine.listRecentPurgeRequests(30, 100)).slice().sort();
      const capped = await engine.listRecentPurgeRequests(30, 2);
      expect(empty).toEqual([]);
      expect(all).toEqual([A, B, C]);
      expect(capped).toHaveLength(2);
      // A later purge of the same page replaces the row, so the request that purged it before no longer counts.
      await recordPagePurge(engine, backend, 'wiki', ['h3'], 'notes/c', A);
      const replaced = (await engine.listRecentPurgeRequests(30, 100)).slice().sort();
      expect(replaced).toEqual([A, B]);
      return { empty, all, capped: capped.length, replaced };
    },
  );
});
