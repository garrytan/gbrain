/**
 * BrainEngine parity — owner_only family (ownerOnlyMarkTriggers, GST-3032).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every SQL arm reports the owner-only delete triggers (migration v322) that are missing and whether
 *    owner-only lineage reads closed, and `ensure` recreates a trigger on a table the role owns.
 *  - Regression: an engine that reports a fresh brain's triggers as missing (so every migration run warns and doctor
 *    fails), or whose `ensure` leaves an owned trigger missing (so a delete marks nothing).
 *  - Why existing coverage misses it: test/owner-only-removal-lineage.test.ts runs the lineage end to end per engine
 *    but never compares the arms' answers.
 *  - Seam: none. Real engines; the second case drops a trigger with raw SQL, so it requires raw_sql.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: owner_only', () => {
  parityTest('ownerOnlyMarkTriggers finds every delete trigger on a fresh brain', { methods: ['ownerOnlyMarkTriggers'] }, async (engine) => {
    const read = await engine.ownerOnlyMarkTriggers();
    const ensured = await engine.ownerOnlyMarkTriggers({ ensure: true });
    const answers = [read, ensured].map(s => ({ missing: s.missing, closed: s.closed }));
    expect(answers).toEqual([{ missing: [], closed: false }, { missing: [], closed: false }]);
    return answers;
  });

  parityTest(
    'ownerOnlyMarkTriggers names a dropped trigger and ensure recreates it on a table the role owns',
    { methods: ['executeRaw', 'ownerOnlyMarkTriggers'], requires: 'raw_sql' },
    async (engine) => {
      await engine.executeRaw('DROP TRIGGER gbrain_owner_only_row_deleted_trg ON takes');
      const read = await engine.ownerOnlyMarkTriggers();
      const ensured = await engine.ownerOnlyMarkTriggers({ ensure: true });
      const answers = [read, ensured].map(s => ({ missing: s.missing.map(m => ({ table: m.table, owned: m.owned })), closed: s.closed }));
      expect(answers).toEqual([{ missing: [{ table: 'takes', owned: true }], closed: false }, { missing: [], closed: false }]);
      return answers;
    },
  );
});
