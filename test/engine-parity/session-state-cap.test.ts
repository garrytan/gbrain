/**
 * BrainEngine parity: the per-(source_id, client_id) row cap of engine-sql/session-state.ts
 * (`capSessionStatePerClient`), which context/session-state.ts gcSessionContextState used to run through
 * `engine.executeRaw` as a DELETE over row_number() OVER (PARTITION BY source_id, client_id ORDER BY updated_at DESC).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm keeps the same rows of each (source_id, client_id) lane at a small cap, including
 *    rows that tie on updated_at because one transaction wrote them. Pinned as it is on master: the database sort
 *    breaks a tie over the rows' heap order, so the kept rows of a one-transaction burst depend on insert order.
 *  - Regression: an engine that caps by another order, or breaks ties another way, drops sessions Postgres keeps, and
 *    a session whose cursor is dropped re-delivers its whole delta.
 *  - Why existing coverage misses it: test/session-state-gc.test.ts runs on PGLite only, with distinct updated_at.
 *  - Seam: the members on the engine handle; rows written in one `engine.transaction` share one updated_at. No
 *    timestamp the engine generates is compared.
 *  - Own file: the heap keeps insert order only while no pruned line pointer is free for reuse. A reset deletes
 *    rows but keeps the table, and the in-place rewrites the other session-state cases make leave free line pointers
 *    that a later burst fills out of order. Each file gets a new PGLite brain and a new Postgres database, and these
 *    cases only insert until the last two, so the heap order stays the insert order.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SessionStateWrite } from '../../src/core/engine-sql/session-state.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

/** A write that only touches updated_at. */
const KEEP: SessionStateWrite = {
  standingEntities: [], surfacedSlugs: [], lastWakeAt: null, replaceStanding: false, replaceCursorSlug: false,
  factsCursorAt: null, factsCursorId: null, degradedWakes: 'keep',
};

/** Which of `rows` of source `sourceId` still have a row, as `client/session`, sorted. */
async function kept(engine: BrainEngine, sourceId: string, rows: ReadonlyArray<readonly [string, string]>): Promise<string[]> {
  const out: string[] = [];
  for (const [client, session] of rows) {
    if (await engine.readSessionCursor(sourceId, client, session)) out.push(`${client}/${session}`);
  }
  return [...new Set(out)].sort();
}

/** Writes `rows` to source `sourceId` in one transaction (one updated_at), then caps each lane at `cap`. */
async function burst(engine: BrainEngine, sourceId: string, rows: ReadonlyArray<readonly [string, string]>, cap: number): Promise<void> {
  await engine.transaction(async (tx) => {
    for (const [client, session] of rows) await tx.upsertSessionState(sourceId, client, session, KEEP);
  });
  await engine.capSessionStatePerClient(cap);
}

const oneLane = (sessions: readonly string[]) => sessions.map((s) => ['c', s] as const);
/** Two interleaved lanes in a scrambled order: row i goes to client c (odd i) or d (even i) as session m<(17i) mod n>. */
const twoLanes = (n: number) =>
  Array.from({ length: n }, (_, i) => [i % 2 ? 'c' : 'd', `m${String((i * 17) % n).padStart(2, '0')}`] as const);

describe('engine parity: session state row cap', () => {
  // Measured on PGLite and Postgres 17. The heap order is the insert order of the burst: see the header for why these
  // cases have their own file.
  const ties: Array<[string, ReadonlyArray<readonly [string, string]>, number, string[]]> = [
    ['ascending', oneLane(['s1', 's2', 's3', 's4', 's5']), 2, ['c/s1', 'c/s2']],
    ['descending', oneLane(['s5', 's4', 's3', 's2', 's1']), 2, ['c/s4', 'c/s5']],
    ['scrambled', oneLane(['s3', 's1', 's5', 's2', 's4']), 2, ['c/s1', 'c/s3']],
    ['twelve rows', oneLane(['k07', 'k03', 'k11', 'k01', 'k09', 'k12', 'k05', 'k02', 'k10', 'k04', 'k08', 'k06']), 5,
      ['c/k01', 'c/k03', 'c/k07', 'c/k09', 'c/k11']],
    ['two lanes of 6', twoLanes(6), 1, ['c/m05', 'd/m00']],
    ['two lanes of 7', twoLanes(7), 1, ['c/m02', 'd/m00']],
    ['two lanes of 8', twoLanes(8), 2, ['c/m01', 'c/m05', 'd/m02', 'd/m04']],
    ['two lanes of 10', twoLanes(10), 2, ['c/m03', 'c/m07', 'd/m02', 'd/m06']],
    ['two lanes of 40', twoLanes(40), 10, [
      'c/m05', 'c/m11', 'c/m13', 'c/m19', 'c/m21', 'c/m25', 'c/m27', 'c/m31', 'c/m37', 'c/m39',
      'd/m04', 'd/m10', 'd/m16', 'd/m20', 'd/m22', 'd/m26', 'd/m28', 'd/m32', 'd/m34', 'd/m38',
    ]],
  ];
  for (const [name, rows, cap, expected] of ties) {
    parityTest(
      `capSessionStatePerClient breaks a tie on equal updated_at as the Postgres sort does: ${name}`,
      { methods: ['upsertSessionState', 'transaction', 'capSessionStatePerClient', 'readSessionCursor'] },
      async (engine) => {
        await burst(engine, 'default', rows, cap);
        const left = await kept(engine, 'default', rows);
        expect(left).toEqual(expected);
        return left;
      },
    );
  }

  parityTest(
    'capSessionStatePerClient ranks rows rewritten in one transaction in the order of the rewrite',
    { methods: ['upsertSessionState', 'transaction', 'capSessionStatePerClient', 'readSessionCursor'] },
    async (engine) => {
      await burst(engine, 'default', oneLane(['s1', 's2', 's3', 's4', 's5']), 5);
      await burst(engine, 'default', oneLane(['s5', 's3', 's1', 's4', 's2']), 2);
      const left = await kept(engine, 'default', oneLane(['s1', 's2', 's3', 's4', 's5']));
      expect(left).toEqual(['c/s3', 'c/s5']);
      return left;
    },
  );

  parityTest(
    'capSessionStatePerClient keeps the newest rows of each (source, client) lane',
    { methods: ['upsertSessionState', 'transaction', 'capSessionStatePerClient', 'readSessionCursor'] },
    async (engine) => {
      // One transaction per write: each write gets its own, later updated_at.
      for (const session of ['s1', 's2', 's3', 's4']) {
        await engine.transaction(async (tx) => {
          await tx.upsertSessionState('default', 'c', session, KEEP);
          await tx.upsertSessionState('default', 'd', session, KEEP);
        });
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      // Rewriting s1 makes it the newest of lane c.
      await engine.upsertSessionState('default', 'c', 's1', KEEP);
      await engine.upsertSessionState('other', 'c', 's9', KEEP);
      await engine.capSessionStatePerClient(2);
      const lanes = {
        c: await kept(engine, 'default', oneLane(['s1', 's2', 's3', 's4'])),
        d: await kept(engine, 'default', [['d', 's1'], ['d', 's2'], ['d', 's3'], ['d', 's4']]),
        other: (await engine.readSessionCursor('other', 'c', 's9')) !== null,
      };
      expect(lanes).toEqual({ c: ['c/s1', 'c/s4'], d: ['d/s3', 'd/s4'], other: true });
      return lanes;
    },
  );
});
