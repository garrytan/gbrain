import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTakesFromDb } from '../src/core/cycle/extract-takes.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
let pageId: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page = await engine.putPage('notes/takes-case', {
    title: 'Takes case',
    type: 'note',
    compiled_truth: `# Takes case\n\n${renderTakesFence([
      { rowNum: 1, claim: 'Earlier claim', kind: 'bet', holder: 'world', weight: 0.5,
        source: 'original note; superseded by #2', active: false },
      { rowNum: 2, claim: 'Current claim', kind: 'bet', holder: 'world', weight: 0.6, active: true },
    ])}\n`,
  });
  pageId = page.id;
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

test('reconcile preserves the fence supersession pointer', async () => {
  await extractTakesFromDb(engine, { slugs: ['notes/takes-case'], rebuild: true });
  const [row] = await engine.executeRaw<{ superseded_by: number | string | null }>(
    'SELECT superseded_by FROM takes WHERE page_id = $1 AND row_num = 1', [pageId]);
  expect(row?.superseded_by == null ? null : Number(row.superseded_by)).toBe(2);
});
