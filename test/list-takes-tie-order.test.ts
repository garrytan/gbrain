/**
 * #8882: listTakes pages through takes that share created_at.
 *
 * Protects: LIMIT/OFFSET paging over takes written by one addTakesBatch (one
 * created_at) returns every take exactly once, in the unpaged order.
 * Fails when: the ORDER BY has no unique tiebreaker, so the sort among tied
 * rows depends on the plan (top-N heapsort for a small LIMIT) and pages skip
 * or repeat takes.
 * Seams: none; real PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

test('paging takes tied on created_at returns each take once, in the unpaged order', async () => {
  const page = await engine.putPage('people/alice-example', { title: 'Alice Example', type: 'person', compiled_truth: 'x' });
  await engine.addTakesBatch(Array.from({ length: 24 }, (_, i) => ({
    page_id: page.id, row_num: i + 1, claim: `claim ${i}`, kind: 'take' as const, holder: 'brain', weight: 0.5,
  })));
  const all = await engine.listTakes({ page_id: page.id, limit: 100 });
  expect(new Set(all.map(t => String(t.created_at))).size).toBe(1);
  const paged: number[] = [];
  for (let offset = 0; offset < all.length; offset += 5) {
    paged.push(...(await engine.listTakes({ page_id: page.id, limit: 5, offset })).map(t => t.id));
  }
  expect(paged).toEqual(all.map(t => t.id));
});
