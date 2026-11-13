/**
 * #8390: a takes rebuild keeps the supersession pointer the fence records.
 *
 * Protects: `extractTakesFromDb` (plain and rebuild) stores
 * `superseded_by = N` for an inactive fence row whose source cell says
 * `superseded by #N`, the same row the page-write path projects.
 * Fails when: the reconcile path builds its batch rows with
 * `superseded_by: null`, so a rebuild wipes the pointer takes_supersede wrote.
 * Seams: none; real PGLite.
 */
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
  const page = await engine.putPage('companies/acme-example', {
    title: 'Acme Example',
    type: 'company',
    compiled_truth: `# Acme Example\n\n## Takes\n\n${renderTakesFence([
      { rowNum: 1, claim: 'Acme example ships in Q3', kind: 'bet', holder: 'world', weight: 0.5, source: 'call notes; superseded by #2', active: false },
      { rowNum: 2, claim: 'Acme example ships in Q4', kind: 'bet', holder: 'world', weight: 0.6, active: true },
    ])}\n`,
  });
  pageId = page.id;
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

const pointer = async (rowNum: number) => {
  const [row] = await engine.executeRaw<{ superseded_by: number | string | null }>(
    'SELECT superseded_by FROM takes WHERE page_id = $1 AND row_num = $2', [pageId, rowNum]);
  return row?.superseded_by == null ? null : Number(row.superseded_by);
};

for (const rebuild of [false, true]) {
  test(`extractTakesFromDb (rebuild=${rebuild}) stores the fence's superseded-by pointer`, async () => {
    await extractTakesFromDb(engine, { slugs: ['companies/acme-example'], rebuild });
    expect(await pointer(1)).toBe(2);
    expect(await pointer(2)).toBeNull();
  });
}
