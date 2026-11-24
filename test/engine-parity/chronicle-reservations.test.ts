/**
 * Engine parity for the automatic chronicle judge reservations (chronicle/ledger.ts `reserveChronicleSlot` and
 * `pruneChronicleReservations`): the daily judge limit and its two-day pruning answer the same on every engine.
 *
 * Fail-first: on rust-engine/chronicle-decision-rust e4420913f5 both cases fail on every arm (the members
 * `reserveChronicleJudgeSlot` and `pruneChronicleReservations` did not exist, so the harness saw them declared but not
 * called), and on the Rust arm each ledger call ended on the raw_sql refusal of `executeRaw` (ledger.ts:96 and :107).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) a reservation below the daily limit records one row and answers true; at the limit it answers
 *    false and records nothing; the 24 h count reads each step. (2) Pruning keeps every reservation of the last two
 *    days: after it the count is unchanged, and a reservation still answers false at the limit. A reservation older
 *    than 48 h is removed by the prune: the SQL engines pin that boundary in test/chronicle-reservations-prune.test.ts
 *    and the store in rust/crates/gbrain-store/tests/chronicle_ledger.rs (its clock moves; no engine member writes an
 *    old reservation, so no parity case can seed one).
 *  - Regression: both ledger functions ran `executeRaw`, which the Rust engine refuses, so the chronicle cycle phase
 *    failed on its first statement there (cycle/chronicle.ts:150) and an automatic judge call could never reserve.
 *  - Why existing coverage misses it: test/chronicle-*.test.ts run on PGLite and Postgres only, and
 *    chronicle-decision.test.ts reads the count without reserving.
 *  - Seam: none. Real engines and the ledger functions the executor and the cycle phase call.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { pruneChronicleReservations, reserveChronicleSlot } from '../../src/core/chronicle/ledger.ts';

const { parityTest } = parityArms(testBackends());
const key = (pageId: number) => ({ sourceId: 'default', pageId, contentHash: `hash-${pageId}` });

describe('engine parity: chronicle judge reservations', () => {
  parityTest('a reservation records one row below the daily limit and refuses at it', {
    methods: ['reserveChronicleJudgeSlot', 'countRecentChronicleReservations'],
  }, async (engine) => {
    const steps: { reserved: boolean; count: number }[] = [];
    for (const pageId of [1, 2, 3]) {
      const reserved = await reserveChronicleSlot(engine, 2, key(pageId));
      steps.push({ reserved, count: await engine.countRecentChronicleReservations() });
    }
    // A higher limit takes the next slot again.
    const raised = await reserveChronicleSlot(engine, 3, key(3));
    const out = { steps, raised, count: await engine.countRecentChronicleReservations() };
    expect(out).toEqual({ steps: [{ reserved: true, count: 1 }, { reserved: true, count: 2 }, { reserved: false, count: 2 }], raised: true, count: 3 });
    return out;
  });

  parityTest('pruning keeps the reservations of the last two days', {
    methods: ['reserveChronicleJudgeSlot', 'pruneChronicleReservations', 'countRecentChronicleReservations'],
  }, async (engine) => {
    await reserveChronicleSlot(engine, 5, key(1));
    await reserveChronicleSlot(engine, 5, key(2));
    const before = await engine.countRecentChronicleReservations();
    await pruneChronicleReservations(engine);
    const after = await engine.countRecentChronicleReservations();
    const atLimit = await reserveChronicleSlot(engine, 2, key(3));
    const out = { before, after, atLimit };
    expect(out).toEqual({ before: 2, after: 2, atLimit: false });
    return out;
  });
});
