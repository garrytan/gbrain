/**
 * BrainEngine parity: the per-(source_id, client_id) row cap of engine-sql/session-state.ts
 * (`capSessionStatePerClient`), which context/session-state.ts gcSessionContextState used to run through
 * `engine.executeRaw` as a DELETE over row_number() OVER (PARTITION BY source_id, client_id ORDER BY updated_at DESC).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm keeps the same rows of each (source_id, client_id) lane at a small cap, including
 *    rows that tie on updated_at because one transaction wrote them. The rank is a total order, updated_at DESC
 *    then session_id COLLATE "C" (bytes), so among tied rows the lowest session_id bytes are kept, whatever the
 *    insert order, the rewrites or the heap state.
 *  - Regression: an engine that caps by another order, or breaks ties another way (the heap order the sort used to
 *    fall back on), drops sessions another arm keeps, and a session whose cursor is dropped re-delivers its delta.
 *  - Why existing coverage misses it: test/session-state-gc.test.ts runs on PGLite only, with distinct updated_at.
 *  - Seam: the members on the engine handle; rows written in one `engine.transaction` share one updated_at. No
 *    timestamp the engine generates is compared.
 *  - Heap state: the tie cases write in many insert orders, and one case rewrites rows and caps before a burst, so
 *    the burst fills freed heap space out of insert order. The kept rows must not change with any of that.
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
  // Tied rows rank by session_id bytes, so the insert order of the burst does not change which rows are kept.
  const ties: Array<[string, ReadonlyArray<readonly [string, string]>, number, string[]]> = [
    ['ascending', oneLane(['s1', 's2', 's3', 's4', 's5']), 2, ['c/s1', 'c/s2']],
    ['descending', oneLane(['s5', 's4', 's3', 's2', 's1']), 2, ['c/s1', 'c/s2']],
    ['scrambled', oneLane(['s3', 's1', 's5', 's2', 's4']), 2, ['c/s1', 'c/s2']],
    ['twelve rows', oneLane(['k07', 'k03', 'k11', 'k01', 'k09', 'k12', 'k05', 'k02', 'k10', 'k04', 'k08', 'k06']), 5,
      ['c/k01', 'c/k02', 'c/k03', 'c/k04', 'c/k05']],
    ['two lanes of 6', twoLanes(6), 1, ['c/m01', 'd/m00']],
    ['two lanes of 7', twoLanes(7), 1, ['c/m01', 'd/m00']],
    ['two lanes of 8', twoLanes(8), 2, ['c/m01', 'c/m03', 'd/m00', 'd/m02']],
    ['two lanes of 10', twoLanes(10), 2, ['c/m01', 'c/m03', 'd/m00', 'd/m02']],
    ['two lanes of 40', twoLanes(40), 10, [
      'c/m01', 'c/m03', 'c/m05', 'c/m07', 'c/m09', 'c/m11', 'c/m13', 'c/m15', 'c/m17', 'c/m19',
      'd/m00', 'd/m02', 'd/m04', 'd/m06', 'd/m08', 'd/m10', 'd/m12', 'd/m14', 'd/m16', 'd/m18',
    ]],
    // Bytes, not a locale: 'S2' (0x53) sorts before 's1' (0x73), and a prefix before a longer id.
    ['bytes, not a locale', oneLane(['s1', 'S2', 's', 's10']), 2, ['c/S2', 'c/s']],
  ];
  for (const [name, rows, cap, expected] of ties) {
    parityTest(
      `capSessionStatePerClient breaks a tie on equal updated_at by session_id bytes: ${name}`,
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
    'capSessionStatePerClient ranks rows rewritten in one transaction by session_id bytes, not rewrite order',
    { methods: ['upsertSessionState', 'transaction', 'capSessionStatePerClient', 'readSessionCursor'] },
    async (engine) => {
      await burst(engine, 'default', oneLane(['s1', 's2', 's3', 's4', 's5']), 5);
      await burst(engine, 'default', oneLane(['s5', 's3', 's1', 's4', 's2']), 2);
      const left = await kept(engine, 'default', oneLane(['s1', 's2', 's3', 's4', 's5']));
      expect(left).toEqual(['c/s1', 'c/s2']);
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

  parityTest(
    'capSessionStatePerClient breaks a tie by session_id bytes after rewrites and a cap free heap space',
    { methods: ['upsertSessionState', 'transaction', 'capSessionStatePerClient', 'readSessionCursor'] },
    async (engine) => {
      // Rows of about 1.5 KB, so a few fill a heap page and the rewrites and the cap leave space a later burst reuses.
      const big = (tag: string): SessionStateWrite => ({
        ...KEEP, replaceStanding: true,
        standingEntities: Array.from({ length: 60 }, (_, i) => `people/${tag}-${String(i).padStart(3, '0')}-example`),
      });
      await engine.transaction(async (tx) => {
        for (const s of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) await tx.upsertSessionState('default', 'c', s, big(s));
      });
      for (const s of ['a2', 'a4', 'a6']) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        await engine.transaction(async (tx) => { await tx.upsertSessionState('default', 'c', s, big(`${s}x`)); });
      }
      await engine.capSessionStatePerClient(3);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const burst = ['b5', 'b3', 'b1', 'b4', 'b2'];
      await engine.transaction(async (tx) => {
        for (const s of burst) await tx.upsertSessionState('default', 'c', s, big(s));
      });
      await engine.capSessionStatePerClient(2);
      const left = await kept(engine, 'default', oneLane(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', ...burst]));
      expect(left).toEqual(['c/b1', 'c/b2']);
      return left;
    },
  );
});
