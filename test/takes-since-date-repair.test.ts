import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { repairTakeSinceDates } from '../src/core/takes-since-date-repair.ts';

let engine: PGLiteEngine;
let realPageId: number;
let fallbackPageId: number;
let undatedPageId: number;

async function seedPage(slug: string, title: string): Promise<number> {
  const page = await engine.putPage(slug, {
    title,
    type: 'company',
    compiled_truth: `${title}\n`,
  });
  return page.id;
}

beforeEach(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  realPageId = await seedPage('companies/real-date-example', 'Real Date Example');
  fallbackPageId = await seedPage('companies/fallback-date-example', 'Fallback Date Example');
  undatedPageId = await seedPage('companies/undated-example', 'Undated Example');

  await engine.executeRaw(
    `UPDATE pages SET effective_date = $1::timestamptz, effective_date_source = $2 WHERE id = $3`,
    ['2025-04-15T00:00:00.000Z', 'date', realPageId],
  );
  await engine.executeRaw(
    `UPDATE pages SET effective_date = $1::timestamptz, effective_date_source = $2 WHERE id = $3`,
    ['2025-05-20T00:00:00.000Z', 'fallback', fallbackPageId],
  );
  await engine.executeRaw(
    `UPDATE pages SET effective_date = NULL, effective_date_source = NULL WHERE id = $1`,
    [undatedPageId],
  );

  await engine.addTakesBatch([
    { page_id: realPageId, row_num: 1, claim: 'Real dated claim', kind: 'bet', holder: 'garry', weight: 0.6 },
    { page_id: realPageId, row_num: 2, claim: 'Already dated claim', kind: 'bet', holder: 'garry', weight: 0.7, since_date: '2024-01-01' },
    { page_id: fallbackPageId, row_num: 1, claim: 'Fallback dated claim', kind: 'bet', holder: 'garry', weight: 0.5 },
    { page_id: undatedPageId, row_num: 1, claim: 'Undated claim', kind: 'bet', holder: 'garry', weight: 0.5 },
  ]);
});

afterEach(async () => {
  await engine.disconnect();
});

describe('repairTakeSinceDates', () => {
  test('dry-run lists only missing since dates backed by real page dates', async () => {
    const result = await repairTakeSinceDates(engine, { limit: 10 });
    expect(result.dry_run).toBe(true);
    expect(result.updated).toBe(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      page_slug: 'companies/real-date-example',
      row_num: 1,
      effective_date: '2025-04-15',
      effective_date_source: 'date',
    });

    const fallbackTakes = await engine.listTakes({ page_id: fallbackPageId });
    expect(fallbackTakes[0].since_date).toBeNull();
    const realTakes = await engine.listTakes({ page_id: realPageId, active: true });
    expect(realTakes.find((take) => take.row_num === 1)?.since_date).toBeNull();
    expect(realTakes.find((take) => take.row_num === 2)?.since_date).toBe('2024-01-01');
  });

  test('apply updates capped candidates and remains idempotent', async () => {
    const first = await repairTakeSinceDates(engine, { apply: true, limit: 1 });
    expect(first.dry_run).toBe(false);
    expect(first.candidates).toHaveLength(1);
    expect(first.updated).toBe(1);

    const realTakes = await engine.listTakes({ page_id: realPageId, active: true });
    expect(realTakes.find((take) => take.row_num === 1)?.since_date).toBe('2025-04-15');
    expect(realTakes.find((take) => take.row_num === 2)?.since_date).toBe('2024-01-01');

    const fallbackTakes = await engine.listTakes({ page_id: fallbackPageId });
    expect(fallbackTakes[0].since_date).toBeNull();

    const second = await repairTakeSinceDates(engine, { apply: true, limit: 10 });
    expect(second.candidates).toHaveLength(0);
    expect(second.updated).toBe(0);
  });
});
