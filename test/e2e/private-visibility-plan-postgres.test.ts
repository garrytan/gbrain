/**
 * The private-page rule (privatePagesFilterFragment) as Postgres plans it.
 *
 * Declared lineage matches `derived_from` slugs with `= ANY(ARRAY(...))`
 * instead of `IN (SELECT ... jsonb_array_elements_text(...))`. The two forms
 * select the same pages, but the planner priced the IN form as a 100-row
 * semi-join per page, so every read carrying the rule (list_pages, backlink
 * counts, search legs for remote callers) cost about 1,500 per page and
 * crossed `jit_above_cost`: Postgres then spent tens of milliseconds
 * compiling a statement that runs in under one.
 *
 *   1. both forms return the same pages, in the same order, over a fixture
 *      holding every rule (explicit private, atoms with a private origin,
 *      synthesized concepts, `derived_from` as string, array and `.md`, a
 *      missing and a cross-source `derived_from`, life-chronicle events);
 *   2. precondition: the IN form's estimated cost per page is above
 *      `jit_above_cost / 500`, so any read that checks 500 pages compiles;
 *   3. the emitted form's cost per page is below it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { privatePagesFilterFragment } from '../../src/core/search/private-visibility.ts';

const PAGES = 3_000;

/** The pre-change declared-lineage spelling, rebuilt from the emitted fragment. */
function inSubqueryForm(fragment: string): string {
  const out = fragment.replaceAll('.slug = ANY(ARRAY(\n        SELECT', '.slug IN (\n        SELECT')
    .replaceAll('AS declared(slug)))) ELSE false END', 'AS declared(slug))) ELSE false END');
  if (out === fragment || out.includes('ANY(ARRAY(')) throw new Error('declared-lineage spelling changed; update inSubqueryForm');
  return out;
}

async function planCost(sql: string): Promise<number> {
  const [row] = await getEngine().executeRaw<{ 'QUERY PLAN': Array<{ Plan: { 'Total Cost': number } }> }>(`EXPLAIN (FORMAT JSON) ${sql}`);
  return row['QUERY PLAN'][0].Plan['Total Cost'];
}

(hasDatabase() ? describe : describe.skip)('private-page rule plan cost (Postgres)', () => {
  beforeAll(async () => {
    await setupDB();
    const engine = getEngine();
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('side', 'side') ON CONFLICT (id) DO NOTHING`);
    // Page i: offset i % 23 picks the rule; i - k names a page in the same block.
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter)
      SELECT 'notes/n-' || i, CASE WHEN i % 23 = 9 THEN 'side' ELSE 'default' END,
        CASE i % 23 WHEN 2 THEN 'atom' WHEN 3 THEN 'atom' WHEN 4 THEN 'concept' WHEN 10 THEN 'event' WHEN 11 THEN 'event' WHEN 12 THEN 'event' ELSE 'note' END,
        'Note ' || i, 'body',
        CASE i % 23
          WHEN 0 THEN '{"visibility": "private"}'::jsonb
          WHEN 1 THEN '{"visibility": "world"}'::jsonb
          WHEN 2 THEN jsonb_build_object('source_slug', 'notes/n-' || (i - 2), 'visibility', 'world')
          WHEN 3 THEN jsonb_build_object('source_slug', 'notes/n-' || (i - 2), 'visibility', 'world')
          WHEN 4 THEN '{"synthesized_by": "dream"}'::jsonb
          WHEN 5 THEN jsonb_build_object('derived_from', 'notes/n-' || (i - 5))
          WHEN 6 THEN jsonb_build_object('derived_from', jsonb_build_array('notes/n-' || (i - 5), 'notes/n-' || (i - 6)))
          WHEN 7 THEN jsonb_build_object('derived_from', 'notes/n-' || (i - 7) || '.md')
          WHEN 8 THEN jsonb_build_object('derived_from', jsonb_build_array('notes/n-' || (i - 7), 'notes/never-written'))
          WHEN 9 THEN jsonb_build_object('derived_from', 'notes/n-' || (i - 9))
          WHEN 10 THEN jsonb_build_object('captured_via', 'life-chronicle:meeting', 'event', jsonb_build_object('depth', 'notes/n-' || (i - 10)))
          WHEN 11 THEN jsonb_build_object('captured_via', 'life-chronicle:meeting', 'event', jsonb_build_object('depth', 'notes/n-' || (i - 6)))
          WHEN 12 THEN jsonb_build_object('captured_via', 'life-chronicle:meeting', 'event', jsonb_build_object('depth', 'notes/n-' || (i - 11)))
          ELSE '{}'::jsonb END
      FROM generate_series(0, ${PAGES - 1}) i`);
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE sources');
  }, 120_000);

  afterAll(async () => { await teardownDB(); });

  test('the ANY(ARRAY) and IN spellings hide exactly the same pages', async () => {
    const engine = getEngine();
    const fragment = privatePagesFilterFragment('p');
    const read = (predicate: string) => engine.executeRaw<{ slug: string }>(`SELECT p.slug FROM pages p WHERE ${predicate} ORDER BY p.slug`);
    const emitted = (await read(fragment)).map(row => row.slug);
    const before = (await read(inSubqueryForm(fragment))).map(row => row.slug);
    expect(emitted).toEqual(before);
    const hidden = PAGES - emitted.length;
    // Every rule fires on this fixture: explicit, atom origin, concept, string/array/.md lineage, events.
    expect(hidden).toBeGreaterThanOrEqual(Math.floor(PAGES / 23) * 8);
    for (const offset of [0, 2, 4, 5, 6, 7, 10, 11]) expect(emitted).not.toContain(`notes/n-${23 + offset}`);
    for (const offset of [1, 3, 8, 9, 12]) expect(emitted).toContain(`notes/n-${23 + offset}`);
  });

  test('the rule costs the planner little enough per page that a 500-page read stays under jit_above_cost', async () => {
    const engine = getEngine();
    const [{ jit_above_cost }] = await engine.executeRaw<{ jit_above_cost: string }>(`SELECT current_setting('jit_above_cost') AS jit_above_cost`);
    const budget = Number(jit_above_cost) / 500;
    const fragment = privatePagesFilterFragment('p');
    const scan = (predicate: string) => planCost(`SELECT count(*) FROM pages p WHERE ${predicate}`);
    const base = await scan('true');
    const perPage = async (predicate: string) => ((await scan(predicate)) - base) / PAGES;
    const before = await perPage(inSubqueryForm(fragment));
    const after = await perPage(fragment);
    console.info(JSON.stringify({ metric: 'private-visibility-cost-per-page', before, after, budget }));
    if (before <= budget) throw new Error(`Precondition failed: the IN spelling already costs ${before} per page (budget ${budget}); this check cannot discriminate.`);
    expect(after).toBeLessThan(budget);
  });
});
