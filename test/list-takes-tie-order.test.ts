import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
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

describe('listTakes ordering on created_at ties', () => {
  test('takes tied on created_at list in a stable id-descending order across pages', async () => {
    const page = await engine.putPage('people/tie-example', { title: 'Tie', type: 'person', compiled_truth: 'x' });
    await engine.addTakesBatch(
      Array.from({ length: 5 }, (_, i) => ({
        page_id: page.id, row_num: i + 1, claim: `claim ${i}`, kind: 'take' as const, holder: 'brain', weight: 0.5,
      })),
    );
    const all = await engine.listTakes({ page_id: page.id, limit: 50 });
    const ids = all.map((t) => t.id);
    expect(new Set(all.map((t) => String(t.created_at))).size).toBe(1);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));

    const paged: number[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const rows = await engine.listTakes({ page_id: page.id, limit: 2, offset });
      paged.push(...rows.map((t) => t.id));
    }
    expect(paged).toEqual(ids);
  });
});
