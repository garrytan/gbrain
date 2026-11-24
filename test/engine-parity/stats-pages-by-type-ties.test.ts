/**
 * BrainEngine parity — getStats lists page types with equal counts in byte order on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: getStats().pages_by_type lists the live page types by count, largest first, and breaks a tie by type in
 *    byte order (`COLLATE "C"`), the order the Rust store gives and PGLite sorts by. The key order of the returned object is
 *    the contract: `gbrain stats` prints it as is.
 *  - Regression: the statement ordered by count alone, so a tie came out in the planner's order. On a Postgres with an en_US
 *    collation the grouping sorts the types by that locale (`a_b, a-z, ab, B`), which is not the byte order; the same brain
 *    printed its types in another order on every engine, and test/extract-mentions-engines.serial.test.ts compared the
 *    order and failed on ties.
 *  - Why existing coverage misses it: stats.test.ts seeds types with distinct counts, and CI's Postgres runs in C.UTF-8,
 *    where the planner's order and the byte order agree. This case seeds equal counts from test/helpers/byte-order.ts in
 *    mixed order; run it against an en_US Postgres to see it fail.
 *  - Seam: none. Every case writes through putPage and reads through getStats on the arm engine.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_IDS, MIXED_IDS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

describe('getStats pages_by_type breaks a count tie by byte type', () => {
  parityTest('equal counts list the types in byte order', { methods: ['putPage', 'getStats'] }, async (engine) => {
    for (const type of MIXED_IDS) {
      await engine.putPage(`notes/t-${type}`, { type: type as never, title: type, compiled_truth: `A ${type}.`, timeline: '' });
    }
    const types = Object.keys((await engine.getStats()).pages_by_type);
    expect(types).toEqual([...BYTE_IDS]);
    return types;
  });

  parityTest('a larger count still comes first, then the tie in byte order', { methods: ['putPage', 'getStats'] }, async (engine) => {
    for (const type of MIXED_IDS) {
      await engine.putPage(`notes/t-${type}`, { type: type as never, title: type, compiled_truth: `A ${type}.`, timeline: '' });
    }
    await engine.putPage('notes/t-ab-two', { type: 'ab' as never, title: 'ab two', compiled_truth: 'Two.', timeline: '' });
    const stats = (await engine.getStats()).pages_by_type;
    expect(Object.keys(stats)).toEqual(['ab', 'B', 'a-z', 'a.b', 'a_b']);
    expect(stats.ab).toBe(2);
    return stats;
  });
});
