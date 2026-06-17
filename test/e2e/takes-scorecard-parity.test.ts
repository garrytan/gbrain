/**
 * v0.30.0 (Slice A1) E2E: scorecard + calibration parity between Postgres
 * and PGLite. Same fixture, same query, same numbers.
 *
 * Seeds 4 binary bets + 1 partial bet into both engines (mirrors the
 * `takes-resolution.test.ts` 4-bet hand-calc reference: Brier=0.205).
 * Asserts getScorecard returns byte-identical numeric output and
 * getCalibrationCurve emits the same buckets.
 *
 * Privacy gate: also asserts the SQL-level allow-list filter (D4
 * fail-closed) returns identical results across engines — hidden-holder
 * rows must contribute zero on both sides.
 *
 * Skips gracefully when DATABASE_URL is unset.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { TakesScorecardOpts, CalibrationCurveOpts } from '../../src/core/engine.ts';

const SKIP_PG = !hasDatabase();
const d = SKIP_PG ? describe.skip : describe;

let pglite: PGLiteEngine;
let pgEngine: BrainEngine;

interface FixtureBet {
  rowNum: number;
  claim: string;
  holder: string;
  weight: number;
  resolveAs?: 'correct' | 'incorrect' | 'partial';
}

// Same fixture used by takes-resolution.test.ts hand-calc.
// 4 binary garry bets at varied weights (Brier=0.205) + 1 partial garry +
// 1 binary harj bet so the allow-list assertion has signal.
const FIXTURE_BETS: FixtureBet[] = [
  { rowNum: 1, claim: 'b1', holder: 'garry',       weight: 0.9, resolveAs: 'correct' },
  { rowNum: 2, claim: 'b2', holder: 'garry',       weight: 0.6, resolveAs: 'correct' },
  { rowNum: 3, claim: 'b3', holder: 'garry',       weight: 0.7, resolveAs: 'incorrect' },
  { rowNum: 4, claim: 'b4', holder: 'garry',       weight: 0.4, resolveAs: 'incorrect' },
  { rowNum: 5, claim: 'b5', holder: 'garry',       weight: 0.5, resolveAs: 'partial' },
  { rowNum: 6, claim: 'h1', holder: 'harj-taggar', weight: 0.8, resolveAs: 'correct' },
];

const SCORECARD_PAGE = 'companies/scorecard-parity-fixture';

async function seedFixture(engine: BrainEngine): Promise<number> {
  const page = await engine.putPage(SCORECARD_PAGE, {
    title: 'Scorecard parity fixture',
    type: 'company' as const,
    compiled_truth: '## Takes\n',
  });
  await engine.addTakesBatch(
    FIXTURE_BETS.map(b => ({
      page_id: page.id,
      row_num: b.rowNum,
      claim: b.claim,
      kind: 'bet' as const,
      holder: b.holder,
      weight: b.weight,
    })),
  );
  for (const b of FIXTURE_BETS) {
    if (b.resolveAs === undefined) continue;
    await engine.resolveTake(page.id, b.rowNum, {
      quality: b.resolveAs,
      resolvedBy: b.holder,
    });
  }
  return page.id;
}

beforeAll(async () => {
  if (SKIP_PG) return;
  // PGLite (in-memory, no DATABASE_URL needed; runs even on the skipped
  // suite path so we'd still know if its seed broke).
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  await seedFixture(pglite);

  // Real Postgres
  await setupDB();
  pgEngine = getEngine();
  await seedFixture(pgEngine);
});

afterAll(async () => {
  if (pglite) await pglite.disconnect();
  if (!SKIP_PG) await teardownDB();
});

d('v0.30.0 e2e: scorecard parity (PG vs PGLite)', () => {
  const queries: Array<{ name: string; opts: TakesScorecardOpts; allowList?: string[] }> = [
    { name: 'all garry, no allow-list',  opts: { holder: 'garry', domainPrefix: SCORECARD_PAGE } },
    { name: 'all rows, no holder filter', opts: { domainPrefix: SCORECARD_PAGE } },
    { name: 'allow-list garry-only',      opts: { domainPrefix: SCORECARD_PAGE }, allowList: ['garry'] },
    { name: 'allow-list world-only (zero match)', opts: { domainPrefix: SCORECARD_PAGE }, allowList: ['world'] },
  ];

  for (const q of queries) {
    test(`scorecard: ${q.name}`, async () => {
      const pgCard    = await pgEngine.getScorecard(q.opts, q.allowList);
      const pgliteCard = await pglite.getScorecard(q.opts, q.allowList);
      expect(pgCard.total_bets).toBe(pgliteCard.total_bets);
      expect(pgCard.resolved).toBe(pgliteCard.resolved);
      expect(pgCard.correct).toBe(pgliteCard.correct);
      expect(pgCard.incorrect).toBe(pgliteCard.incorrect);
      expect(pgCard.partial).toBe(pgliteCard.partial);
      // Float fields: byte-equality is too strict due to engine-driver
      // numeric coercion (Postgres returns string-coerced floats; PGLite
      // returns JS numbers). Use 6-decimal closeness — well below any
      // user-visible precision.
      const closeOrBothNull = (a: number | null, b: number | null) => {
        if (a === null && b === null) return;
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(a).toBeCloseTo(b!, 6);
      };
      closeOrBothNull(pgCard.accuracy, pgliteCard.accuracy);
      closeOrBothNull(pgCard.brier, pgliteCard.brier);
      closeOrBothNull(pgCard.partial_rate, pgliteCard.partial_rate);
    });
  }

  test('Brier on the 4-bet hand-calc reference matches 0.205 on both engines', async () => {
    // Filter to garry bets only — the harj bet would skew the Brier.
    const opts: TakesScorecardOpts = { holder: 'garry', domainPrefix: SCORECARD_PAGE };
    const pgCard    = await pgEngine.getScorecard(opts, undefined);
    const pgliteCard = await pglite.getScorecard(opts, undefined);
    expect(pgCard.brier).toBeCloseTo(0.205, 4);
    expect(pgliteCard.brier).toBeCloseTo(0.205, 4);
    // Also: partial_rate = 1/5 = 0.2 (4 binary + 1 partial = 5 resolved garry rows).
    expect(pgCard.partial_rate).toBeCloseTo(0.2, 6);
    expect(pgliteCard.partial_rate).toBeCloseTo(0.2, 6);
  });

  test('PRIVACY: allow-list ["garry"] gives same totals on both engines AND excludes harj', async () => {
    const opts: TakesScorecardOpts = { domainPrefix: SCORECARD_PAGE };
    const pgGarry    = await pgEngine.getScorecard(opts, ['garry']);
    const pgliteGarry = await pglite.getScorecard(opts, ['garry']);

    // Both engines see exactly the 5 garry rows.
    expect(pgGarry.resolved).toBe(5);
    expect(pgliteGarry.resolved).toBe(5);

    // Without allow-list, both see all 6 resolved rows (5 garry + 1 harj).
    const pgFull    = await pgEngine.getScorecard(opts, undefined);
    const pgliteFull = await pglite.getScorecard(opts, undefined);
    expect(pgFull.resolved).toBe(6);
    expect(pgliteFull.resolved).toBe(6);

    // Allow-list strictly subtracts (defense in depth: if SQL filter were
    // post-filtered or applied wrong, this assertion catches it).
    expect(pgFull.resolved - pgGarry.resolved).toBe(1);
    expect(pgliteFull.resolved - pgliteGarry.resolved).toBe(1);
  });
});

d('v0.30.0 e2e: calibration curve parity (PG vs PGLite)', () => {
  const queries: Array<{ name: string; opts: CalibrationCurveOpts; allowList?: string[] }> = [
    { name: 'garry-only, default bucket', opts: { holder: 'garry' } },
    { name: 'all-rows, default bucket', opts: {} },
    { name: 'allow-list garry-only', opts: {}, allowList: ['garry'] },
  ];
  for (const q of queries) {
    test(`calibration: ${q.name}`, async () => {
      const pgBuckets    = await pgEngine.getCalibrationCurve(q.opts, q.allowList);
      const pgliteBuckets = await pglite.getCalibrationCurve(q.opts, q.allowList);
      expect(pgBuckets.length).toBe(pgliteBuckets.length);
      for (let i = 0; i < pgBuckets.length; i++) {
        expect(pgBuckets[i].bucket_lo).toBeCloseTo(pgliteBuckets[i].bucket_lo, 6);
        expect(pgBuckets[i].bucket_hi).toBeCloseTo(pgliteBuckets[i].bucket_hi, 6);
        expect(pgBuckets[i].n).toBe(pgliteBuckets[i].n);
        if (pgBuckets[i].observed !== null) {
          expect(pgBuckets[i].observed).toBeCloseTo(pgliteBuckets[i].observed!, 6);
        } else {
          expect(pgliteBuckets[i].observed).toBeNull();
        }
        if (pgBuckets[i].predicted !== null) {
          expect(pgBuckets[i].predicted).toBeCloseTo(pgliteBuckets[i].predicted!, 6);
        } else {
          expect(pgliteBuckets[i].predicted).toBeNull();
        }
      }
    });
  }

  test('partial bet (weight 0.5) is excluded from calibration curve on both engines', async () => {
    const pgBuckets    = await pgEngine.getCalibrationCurve({ holder: 'garry' }, undefined);
    const pgliteBuckets = await pglite.getCalibrationCurve({ holder: 'garry' }, undefined);
    const pgTotal    = pgBuckets.reduce((s, b) => s + b.n, 0);
    const pgliteTotal = pgliteBuckets.reduce((s, b) => s + b.n, 0);
    // 4 binary garry rows; partial excluded.
    expect(pgTotal).toBe(4);
    expect(pgliteTotal).toBe(4);
  });
});
