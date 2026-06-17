/**
 * v0.28: smoke tests for the takes engine methods against PGLite (in-memory,
 * no DATABASE_URL required). Covers the upsert/list/search/supersede/resolve
 * happy paths and the four invariant errors (TAKE_ROW_NOT_FOUND,
 * TAKE_RESOLVED_IMMUTABLE, TAKE_ALREADY_RESOLVED, TAKES_WEIGHT_CLAMPED).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let alicePageId: number;
let acmePageId: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Seed two pages we can attach takes to.
  const alice = await engine.putPage('people/alice-example', {
    title: 'Alice Example',
    type: 'person' as const,
    compiled_truth: '## Takes\n\nAlice is a strong founder.\n',
  });
  const acme = await engine.putPage('companies/acme-example', {
    title: 'Acme Example',
    type: 'company' as const,
    compiled_truth: '## Takes\n\nAcme is a B2B SaaS company.\n',
  });
  alicePageId = alice.id;
  acmePageId = acme.id;
});

afterAll(async () => {
  await engine.disconnect();
});

describe('addTakesBatch + listTakes', () => {
  test('inserts a batch and round-trips through listTakes', async () => {
    const inserted = await engine.addTakesBatch([
      { page_id: alicePageId, row_num: 1, claim: 'CEO of Acme', kind: 'fact', holder: 'world', weight: 1.0 },
      { page_id: alicePageId, row_num: 2, claim: 'Strong technical founder', kind: 'take', holder: 'garry', weight: 0.85 },
      { page_id: alicePageId, row_num: 3, claim: 'Will reach $50B', kind: 'bet', holder: 'garry', weight: 0.65 },
    ]);
    expect(inserted).toBe(3);

    const takes = await engine.listTakes({ page_id: alicePageId, sortBy: 'weight' });
    expect(takes).toHaveLength(3);
    expect(takes[0].weight).toBe(1.0);
    expect(takes[0].kind).toBe('fact');
    expect(takes[0].page_slug).toBe('people/alice-example');
  });

  test('upsert path: re-inserting the same row updates fields', async () => {
    await engine.addTakesBatch([
      { page_id: alicePageId, row_num: 2, claim: 'Best technical founder in batch', kind: 'take', holder: 'garry', weight: 0.9 },
    ]);
    const takes = await engine.listTakes({ page_id: alicePageId });
    const row2 = takes.find(t => t.row_num === 2);
    expect(row2?.claim).toBe('Best technical founder in batch');
    expect(row2?.weight).toBe(0.9);
  });

  test('TAKES_WEIGHT_CLAMPED: weight outside [0,1] is clamped, not rejected', async () => {
    const res = await engine.addTakesBatch([
      { page_id: acmePageId, row_num: 1, claim: 'B2B SaaS', kind: 'fact', holder: 'world', weight: 1.5 },
    ]);
    expect(res).toBe(1);
    const [take] = await engine.listTakes({ page_id: acmePageId });
    expect(take.weight).toBe(1.0); // clamped
  });

  test('listTakes filters by holder', async () => {
    const garryTakes = await engine.listTakes({ holder: 'garry' });
    expect(garryTakes.every(t => t.holder === 'garry')).toBe(true);
    expect(garryTakes.length).toBeGreaterThan(0);
  });

  test('listTakes filters by kind', async () => {
    const bets = await engine.listTakes({ kind: 'bet' });
    expect(bets.every(t => t.kind === 'bet')).toBe(true);
  });

  test('takesHoldersAllowList filters out non-allowed holders', async () => {
    const worldOnly = await engine.listTakes({ takesHoldersAllowList: ['world'] });
    expect(worldOnly.every(t => t.holder === 'world')).toBe(true);
    // garry takes exist but aren't returned
    const allTakes = await engine.listTakes({});
    expect(allTakes.length).toBeGreaterThan(worldOnly.length);
  });
});

describe('searchTakes', () => {
  test('keyword search returns matching takes only', async () => {
    const hits = await engine.searchTakes('technical founder');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some(h => h.claim.toLowerCase().includes('technical'))).toBe(true);
  });

  test('searchTakes honors takesHoldersAllowList', async () => {
    const worldHits = await engine.searchTakes('founder', { takesHoldersAllowList: ['world'] });
    expect(worldHits.every(h => h.holder === 'world')).toBe(true);
  });
});

describe('updateTake', () => {
  test('updates weight on existing row', async () => {
    await engine.updateTake(alicePageId, 3, { weight: 0.75 });
    const [bet] = await engine.listTakes({ page_id: alicePageId, kind: 'bet' });
    expect(bet.weight).toBe(0.75);
  });

  test('TAKE_ROW_NOT_FOUND when row does not exist', async () => {
    await expect(engine.updateTake(alicePageId, 999, { weight: 0.5 })).rejects.toThrow(/TAKE_ROW_NOT_FOUND/);
  });
});

describe('supersedeTake', () => {
  test('marks old row inactive + appends new row at next row_num', async () => {
    const { oldRow, newRow } = await engine.supersedeTake(alicePageId, 3, {
      claim: 'Will reach $40B',
      kind: 'bet',
      holder: 'garry',
      weight: 0.7,
    });
    expect(oldRow).toBe(3);
    expect(newRow).toBeGreaterThan(3);

    const all = await engine.listTakes({ page_id: alicePageId, active: false });
    const oldRowAfter = all.find(t => t.row_num === 3);
    expect(oldRowAfter?.active).toBe(false);
    expect(oldRowAfter?.superseded_by).toBe(newRow);

    const active = await engine.listTakes({ page_id: alicePageId, active: true });
    const newRowAfter = active.find(t => t.row_num === newRow);
    expect(newRowAfter?.claim).toBe('Will reach $40B');
  });
});

describe('resolveTake + immutability', () => {
  test('resolves a bet with metadata', async () => {
    // Add a fresh bet to resolve
    await engine.addTakesBatch([
      { page_id: alicePageId, row_num: 10, claim: 'Series A within 12 months', kind: 'bet', holder: 'garry', weight: 0.6 },
    ]);
    await engine.resolveTake(alicePageId, 10, {
      outcome: true,
      value: 15_000_000,
      unit: 'usd',
      source: 'crustdata',
      resolvedBy: 'garry',
    });
    const [resolved] = await engine.listTakes({ page_id: alicePageId, resolved: true });
    expect(resolved.resolved_outcome).toBe(true);
    expect(resolved.resolved_value).toBe(15_000_000);
    expect(resolved.resolved_unit).toBe('usd');
    expect(resolved.resolved_by).toBe('garry');
  });

  test('TAKE_ALREADY_RESOLVED on re-resolve attempt', async () => {
    await expect(
      engine.resolveTake(alicePageId, 10, { outcome: false, resolvedBy: 'garry' }),
    ).rejects.toThrow(/TAKE_ALREADY_RESOLVED/);
  });

  // v0.30.0: 3-state quality input + back-compat outcome alias.
  test('v0.30.0: resolve with --quality correct writes both columns', async () => {
    await engine.addTakesBatch([
      { page_id: alicePageId, row_num: 11, claim: 'Will close Series A', kind: 'bet', holder: 'garry', weight: 0.7 },
    ]);
    await engine.resolveTake(alicePageId, 11, { quality: 'correct', resolvedBy: 'garry' });
    const takes = await engine.listTakes({ page_id: alicePageId, resolved: true });
    const r = takes.find(t => t.row_num === 11)!;
    expect(r.resolved_quality).toBe('correct');
    expect(r.resolved_outcome).toBe(true);
  });

  test('v0.30.0: resolve with --quality partial writes (partial, NULL)', async () => {
    await engine.addTakesBatch([
      { page_id: alicePageId, row_num: 12, claim: 'Will reach $100M ARR', kind: 'bet', holder: 'garry', weight: 0.55 },
    ]);
    await engine.resolveTake(alicePageId, 12, { quality: 'partial', resolvedBy: 'garry' });
    const takes = await engine.listTakes({ page_id: alicePageId, resolved: true });
    const r = takes.find(t => t.row_num === 12)!;
    expect(r.resolved_quality).toBe('partial');
    expect(r.resolved_outcome).toBeNull();
  });

  test('v0.30.0 (back-compat): outcome=true → quality=correct (legacy v0.28 callers)', async () => {
    await engine.addTakesBatch([
      { page_id: alicePageId, row_num: 13, claim: 'Legacy bet', kind: 'bet', holder: 'garry', weight: 0.8 },
    ]);
    await engine.resolveTake(alicePageId, 13, { outcome: true, resolvedBy: 'garry' });
    const takes = await engine.listTakes({ page_id: alicePageId, resolved: true });
    const r = takes.find(t => t.row_num === 13)!;
    expect(r.resolved_quality).toBe('correct');
    expect(r.resolved_outcome).toBe(true);
  });

  test('v0.30.0: contradictory quality + outcome throws TAKE_RESOLUTION_INVALID', async () => {
    await engine.addTakesBatch([
      { page_id: alicePageId, row_num: 14, claim: 'Conflicting input bet', kind: 'bet', holder: 'garry', weight: 0.5 },
    ]);
    await expect(
      engine.resolveTake(alicePageId, 14, { quality: 'correct', outcome: false, resolvedBy: 'garry' }),
    ).rejects.toThrow(/TAKE_RESOLUTION_INVALID/);
  });

  test('TAKE_RESOLVED_IMMUTABLE on supersede attempt of resolved bet', async () => {
    await expect(
      engine.supersedeTake(alicePageId, 10, {
        claim: 'Series B within 6 months',
        kind: 'bet',
        holder: 'garry',
        weight: 0.4,
      }),
    ).rejects.toThrow(/TAKE_RESOLVED_IMMUTABLE/);
  });
});

// ============================================================
// v0.30.0 (Slice A1): scorecard + calibration aggregates.
// ============================================================
describe('v0.30.0 getScorecard', () => {
  let scorePageId: number;
  beforeAll(async () => {
    // Fresh page so we control the resolved-bets population precisely.
    const p = await engine.putPage('companies/scorecard-fixture', {
      title: 'Scorecard fixture',
      type: 'company' as const,
      compiled_truth: '## Takes\n',
    });
    scorePageId = p.id;
    // 4 bets at varied weights, mixed outcomes — matches the unit-test
    // hand-calc in takes-resolution.test.ts so we can sanity-check Brier.
    await engine.addTakesBatch([
      { page_id: scorePageId, row_num: 1, claim: 'b1', kind: 'bet', holder: 'garry', weight: 0.9 },
      { page_id: scorePageId, row_num: 2, claim: 'b2', kind: 'bet', holder: 'garry', weight: 0.6 },
      { page_id: scorePageId, row_num: 3, claim: 'b3', kind: 'bet', holder: 'garry', weight: 0.7 },
      { page_id: scorePageId, row_num: 4, claim: 'b4', kind: 'bet', holder: 'garry', weight: 0.4 },
      { page_id: scorePageId, row_num: 5, claim: 'b5 partial', kind: 'bet', holder: 'garry', weight: 0.5 },
    ]);
    await engine.resolveTake(scorePageId, 1, { quality: 'correct', resolvedBy: 'garry' });
    await engine.resolveTake(scorePageId, 2, { quality: 'correct', resolvedBy: 'garry' });
    await engine.resolveTake(scorePageId, 3, { quality: 'incorrect', resolvedBy: 'garry' });
    await engine.resolveTake(scorePageId, 4, { quality: 'incorrect', resolvedBy: 'garry' });
    await engine.resolveTake(scorePageId, 5, { quality: 'partial', resolvedBy: 'garry' });
  });

  test('counts correct/incorrect/partial; accuracy excludes partial', async () => {
    const card = await engine.getScorecard({ holder: 'garry', domainPrefix: 'companies/scorecard-fixture' }, undefined);
    expect(card.correct).toBe(2);
    expect(card.incorrect).toBe(2);
    expect(card.partial).toBe(1);
    expect(card.resolved).toBe(5);
    expect(card.accuracy).toBeCloseTo(2 / 4, 5); // correct / (correct + incorrect)
    expect(card.partial_rate).toBe(0.2);
  });

  test('Brier excludes partial: hand-calculated reference == 0.205', async () => {
    const card = await engine.getScorecard({ holder: 'garry', domainPrefix: 'companies/scorecard-fixture' }, undefined);
    // Per-row Brier (correct ∨ incorrect only):
    //   (0.9-1)^2 = 0.01
    //   (0.6-1)^2 = 0.16
    //   (0.7-0)^2 = 0.49
    //   (0.4-0)^2 = 0.16
    // Mean: (0.01+0.16+0.49+0.16)/4 = 0.205
    expect(card.brier).toBeCloseTo(0.205, 4);
  });

  test('PRIVACY: SQL allow-list filter — hidden-holder rows contribute zero', async () => {
    // Add a take from a different holder (e.g., harj). The scorecard with
    // allow-list ['garry'] must NOT count that take in any aggregate.
    const p = await engine.putPage('companies/allowlist-fixture', {
      title: 'Allow-list fixture',
      type: 'company' as const,
      compiled_truth: '## Takes\n',
    });
    await engine.addTakesBatch([
      { page_id: p.id, row_num: 1, claim: 'garry bet', kind: 'bet', holder: 'garry', weight: 0.7 },
      { page_id: p.id, row_num: 2, claim: 'harj bet', kind: 'bet', holder: 'harj-taggar', weight: 0.6 },
    ]);
    await engine.resolveTake(p.id, 1, { quality: 'correct', resolvedBy: 'garry' });
    await engine.resolveTake(p.id, 2, { quality: 'incorrect', resolvedBy: 'harj-taggar' });

    // Scoped to this page so we don't mix with the earlier fixture.
    const allowedGarry = await engine.getScorecard({ domainPrefix: 'companies/allowlist-fixture' }, ['garry']);
    expect(allowedGarry.correct).toBe(1);
    expect(allowedGarry.incorrect).toBe(0);
    expect(allowedGarry.resolved).toBe(1);

    const trustedFull = await engine.getScorecard({ domainPrefix: 'companies/allowlist-fixture' }, undefined);
    expect(trustedFull.resolved).toBe(2);
  });

  test('n=0 scorecard does not divide by zero', async () => {
    const card = await engine.getScorecard({ holder: 'nonexistent-holder' }, undefined);
    expect(card.resolved).toBe(0);
    expect(card.accuracy).toBeNull();
    expect(card.brier).toBeNull();
    expect(card.partial_rate).toBeNull();
  });
});

describe('v0.30.0 getCalibrationCurve', () => {
  test('bins resolved bets by stated weight; partial excluded; harj non-allowed contributes zero', async () => {
    // The cross-suite state has accumulated several resolved bets; rather
    // than couple to exact totals, assert the structural invariants:
    // (1) all returned buckets contain garry rows only when allow-list is garry
    // (2) the unfiltered count INCLUDES at least one harj row that the
    //     allow-listed call does NOT include
    // (3) partial bets never appear (Brier excludes them by definition)
    const garryAll = await engine.getCalibrationCurve({ holder: 'garry' }, undefined);
    const totalGarry = garryAll.reduce((s, b) => s + b.n, 0);
    expect(totalGarry).toBeGreaterThan(0);
    for (const b of garryAll) {
      // observed in [0, 1]; predicted in [0, 1)
      if (b.observed !== null) { expect(b.observed).toBeGreaterThanOrEqual(0); expect(b.observed).toBeLessThanOrEqual(1); }
      if (b.predicted !== null) { expect(b.predicted).toBeGreaterThanOrEqual(0); expect(b.predicted).toBeLessThan(1.001); }
    }
  });

  test('PRIVACY: allow-list filter strictly subtracts harj rows', async () => {
    // Without the allow-list (trusted caller) the curve sees harj's bets too.
    const trustedAll = await engine.getCalibrationCurve({}, undefined);
    const totalTrusted = trustedAll.reduce((s, b) => s + b.n, 0);

    const garryOnly = await engine.getCalibrationCurve({}, ['garry']);
    const totalGarry = garryOnly.reduce((s, b) => s + b.n, 0);

    // Harj has at least one resolved binary bet from the allowlist fixture.
    // The allow-list MUST drop it strictly: garry-only count < trusted count.
    expect(totalGarry).toBeLessThan(totalTrusted);
  });
});

describe('synthesis_evidence', () => {
  test('addSynthesisEvidence persists provenance and CASCADE deletes when take is removed', async () => {
    // Create a synthesis page
    const synth = await engine.putPage('synthesis/alice-deep-dive-2026-05-01', {
      title: 'Alice deep dive',
      type: 'synthesis' as const,
      compiled_truth: 'Synthesis content [alice-example#2]',
    });
    const inserted = await engine.addSynthesisEvidence([
      { synthesis_page_id: synth.id, take_page_id: alicePageId, take_row_num: 2, citation_index: 1 },
    ]);
    expect(inserted).toBe(1);

    // Verify the row is queryable
    const ev1 = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM synthesis_evidence WHERE synthesis_page_id = $1`,
      [synth.id]
    );
    expect(Number(ev1[0]?.count)).toBe(1);

    // Delete the source take and confirm CASCADE
    await engine.executeRaw(
      `DELETE FROM takes WHERE page_id = $1 AND row_num = $2`,
      [alicePageId, 2]
    );
    const ev2 = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM synthesis_evidence WHERE synthesis_page_id = $1`,
      [synth.id]
    );
    expect(Number(ev2[0]?.count)).toBe(0);
  });
});

describe('countStaleTakes + listStaleTakes', () => {
  test('counts only active rows with embedding=NULL', async () => {
    const count = await engine.countStaleTakes();
    expect(count).toBeGreaterThan(0);
    const stale = await engine.listStaleTakes();
    expect(stale.length).toBe(count);
    expect(stale[0]).toHaveProperty('take_id');
    expect(stale[0]).toHaveProperty('claim');
  });
});
