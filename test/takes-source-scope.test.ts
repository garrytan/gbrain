/**
 * Regression: takes read ops honor source / federated_read scope via the
 * take's page.source_id, while preserving the holder allow-list. (#2200-class;
 * see garrytan/gbrain#2200 comment.)
 *
 * takes has no source_id column of its own — it's scoped through
 * JOIN pages.source_id (list/search) or EXISTS pages (scorecard/curve).
 * PGLite, in-memory, no DATABASE_URL required.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

async function addSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, NULL, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await addSource('tenant-a');
  await addSource('tenant-b');

  const pageA = await engine.putPage('people/a-ex', { title: 'A', type: 'person', compiled_truth: '## Takes\n' }, { sourceId: 'tenant-a' });
  const pageB = await engine.putPage('people/b-ex', { title: 'B', type: 'person', compiled_truth: '## Takes\n' }, { sourceId: 'tenant-b' });

  await engine.addTakesBatch([
    { page_id: pageA.id, row_num: 1, claim: 'Acme founder will raise a Series A', kind: 'bet', holder: 'garry', weight: 0.7 },
    { page_id: pageA.id, row_num: 2, claim: 'Acme founder went public', kind: 'bet', holder: 'world', weight: 0.6 },
    { page_id: pageB.id, row_num: 1, claim: 'Beta founder will exit big', kind: 'bet', holder: 'garry', weight: 0.8 },
  ]);
  // Resolve so the scorecard/curve aggregates have correct/incorrect rows.
  await engine.resolveTake(pageA.id, 1, { quality: 'correct', resolvedBy: 'garry' });
  await engine.resolveTake(pageA.id, 2, { quality: 'incorrect', resolvedBy: 'world' });
  await engine.resolveTake(pageB.id, 1, { quality: 'correct', resolvedBy: 'garry' });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('listTakes / searchTakes — JOIN pages.source_id scope', () => {
  test('sourceIds (federated) filters to the listed source', async () => {
    const a = await engine.listTakes({ sourceIds: ['tenant-a'] });
    expect(a).toHaveLength(2);
    expect(a.every(t => t.page_slug === 'people/a-ex')).toBe(true);
  });

  test('scalar sourceId filters to that source', async () => {
    const b = await engine.listTakes({ sourceId: 'tenant-b' });
    expect(b).toHaveLength(1);
    expect(b[0].page_slug).toBe('people/b-ex');
  });

  test('no source scope → all sources (local CLI behavior unchanged)', async () => {
    const all = await engine.listTakes({});
    expect(all).toHaveLength(3);
  });

  test('source scope AND holder allow-list compose (intersection)', async () => {
    const r = await engine.listTakes({ sourceIds: ['tenant-a'], takesHoldersAllowList: ['world'] });
    expect(r).toHaveLength(1);
    expect(r[0].holder).toBe('world');
    expect(r[0].page_slug).toBe('people/a-ex');
  });

  test('searchTakes honors source scope', async () => {
    const a = await engine.searchTakes('founder', { sourceIds: ['tenant-a'] });
    expect(a.length).toBeGreaterThan(0);
    expect(a.every(h => h.page_slug === 'people/a-ex')).toBe(true);
  });
});

describe('getScorecard / getCalibrationCurve — EXISTS pages.source_id scope', () => {
  test('getScorecard counts only the scoped source', async () => {
    expect((await engine.getScorecard({ sourceIds: ['tenant-a'] }, undefined)).total_bets).toBe(2);
    expect((await engine.getScorecard({ sourceId: 'tenant-b' }, undefined)).total_bets).toBe(1);
    expect((await engine.getScorecard({}, undefined)).total_bets).toBe(3);
  });

  test('getScorecard source scope AND holder allow-list compose', async () => {
    // tenant-a bets: garry(correct) + world(incorrect); allow-list world → 1 bet
    expect((await engine.getScorecard({ sourceIds: ['tenant-a'] }, ['world'])).total_bets).toBe(1);
  });

  test('getCalibrationCurve buckets only the scoped source', async () => {
    const a = await engine.getCalibrationCurve({ sourceIds: ['tenant-a'] }, undefined);
    expect(a.reduce((s, b) => s + b.n, 0)).toBe(2);
    const b = await engine.getCalibrationCurve({ sourceId: 'tenant-b' }, undefined);
    expect(b.reduce((s, x) => s + x.n, 0)).toBe(1);
  });
});
