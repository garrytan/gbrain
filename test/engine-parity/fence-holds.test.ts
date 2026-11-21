/**
 * BrainEngine parity: the held fence results read.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listFenceHoldRows answers the same on every engine arm that serves it (PGLite always; Postgres with
 *    DATABASE_URL). The Rust arm refuses it as `raw_sql` (src/core/rust-engine/members.ts) until its store wiring lands.
 *  - Regression: the held-fence read of src/core/generations/fence.ts ran through `executeRaw` with a text composed at run
 *    time; a handle that answered it differently changes which fence cells the sync and the reader treat as held.
 *  - Why existing coverage misses it: the statement ran through `executeRaw`, which the parity cases cannot call (D18).
 *  - Seam: none. A held row needs a derived-generation write that no engine member makes at this base, so this file pins
 *    the empty answer for both statement forms (every owner, one owner); the populated answers, the order and the owner
 *    filter are pinned against master's text by test/n5-sql-move-parity.test.ts on PGLite and Postgres.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: held fence results', () => {
  parityTest('listFenceHoldRows answers no rows on a brain with no held results, for every owner and for one owner', { methods: ['listFenceHoldRows'] }, async (engine) => {
    const every = await engine.listFenceHoldRows(['default'], ['fact_fence', 'take_fence']);
    const one = await engine.listFenceHoldRows(['default'], ['fact_fence', 'take_fence'], 'page:people/alice-example');
    const noSources = await engine.listFenceHoldRows([], ['fact_fence']);
    expect(every).toEqual([]);
    expect(one).toEqual([]);
    expect(noSources).toEqual([]);
    return { every, one, noSources };
  });
});
