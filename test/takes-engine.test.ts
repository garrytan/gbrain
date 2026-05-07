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
