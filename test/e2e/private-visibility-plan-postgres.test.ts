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
 *   3. the emitted form's cost per page is below it;
 *   4. it stays below it once the concepts carry provenance links and the
 *      atoms' origins rename history, with links and slug_rename_history
 *      analyzed (the concept-input probe, gbrain_concept_inputs_private,
 *      reads both).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { privatePagesFilterFragment, withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { v311 } from '../../src/core/schema-migrations/v311-concept-inputs-private.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';

const PAGES = 3_000;
/** The slug_rename_history rows the analyzed case writes. */
const FIXTURE_HISTORY = `new_slug LIKE 'archive/notes/n-%'`;

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

/** The rule a remote request on a v311 brain emits: the concept-input test as gbrain_concept_inputs_private (GST-2687). */
function remoteFragment(): string {
  const fragment = withCallerAccess({ remotePolicy: { privacyRelaxed: false, restricted: true, schemaVersion: v311.version } }, () => privatePagesFilterFragment('p'));
  expect(fragment).toContain('gbrain_concept_inputs_private(');
  return fragment;
}

/**
 * The estimated cost per page of the IN spelling (before), the remote rule (after), a local read's rule in its v311
 * engine's scope (local), the inline concept-input test (inline), and the jit budget per page. Inline is what a read
 * plans before v311 applies or with no recorded version: the mid-upgrade state, logged and not held to the budget.
 */
async function costPerPage(): Promise<{ before: number; after: number; local: number; inline: number; budget: number }> {
  const [{ jit_above_cost }] = await getEngine().executeRaw<{ jit_above_cost: string }>(`SELECT current_setting('jit_above_cost') AS jit_above_cost`);
  const fragment = remoteFragment();
  const localFragment = withEngineScope(getEngine(), () => privatePagesFilterFragment('p'));
  expect(localFragment).toContain('gbrain_concept_inputs_private(');
  const inlineFragment = privatePagesFilterFragment('p');
  expect(inlineFragment).not.toContain('gbrain_concept_inputs_private(');
  const scan = (predicate: string) => planCost(`SELECT count(*) FROM pages p WHERE ${predicate}`);
  const base = await scan('true');
  const perPage = async (predicate: string) => ((await scan(predicate)) - base) / PAGES;
  return { before: await perPage(inSubqueryForm(fragment)), after: await perPage(fragment), local: await perPage(localFragment), inline: await perPage(inlineFragment), budget: Number(jit_above_cost) / 500 };
}

/** Both spellings hide the same pages, and each rule of the fixture fires. */
async function expectSameHiddenPages(): Promise<void> {
  const fragment = remoteFragment();
  const read = (predicate: string) => getEngine().executeRaw<{ slug: string }>(`SELECT p.slug FROM pages p WHERE ${predicate} ORDER BY p.slug`);
  const emitted = (await read(fragment)).map(row => row.slug);
  const before = (await read(inSubqueryForm(fragment))).map(row => row.slug);
  expect(emitted).toEqual(before);
  const hidden = PAGES - emitted.length;
  // Every rule fires on this fixture: explicit, atom origin, concept, string/array/.md lineage, events.
  expect(hidden).toBeGreaterThanOrEqual(Math.floor(PAGES / 23) * 8);
  for (const offset of [0, 2, 4, 5, 6, 7, 10, 11]) expect(emitted).not.toContain(`notes/n-${23 + offset}`);
  for (const offset of [1, 3, 8, 9, 12]) expect(emitted).toContain(`notes/n-${23 + offset}`);
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

  afterAll(async () => {
    await getEngine().executeRaw(`DELETE FROM slug_rename_history WHERE ${FIXTURE_HISTORY}`);
    await teardownDB();
  });

  test('the ANY(ARRAY) and IN spellings hide exactly the same pages', async () => {
    await expectSameHiddenPages();
  });

  test('the rule costs the planner little enough per page that a 500-page read stays under jit_above_cost', async () => {
    const { before, after, local, inline, budget } = await costPerPage();
    console.info(JSON.stringify({ metric: 'private-visibility-cost-per-page', before, after, local, inline, budget }));
    if (before <= budget) throw new Error(`Precondition failed: the IN spelling already costs ${before} per page (budget ${budget}); this check cannot discriminate.`);
    expect(after).toBeLessThan(budget);
    expect(local).toBeLessThan(budget);
  });

  test('it stays under jit_above_cost with provenance links and rename history analyzed', async () => {
    const engine = getEngine();
    // Each synthesized concept (offset 4) names the two atoms of its block (offsets 2 and 3) as its inputs.
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT c.id, a.id, 'synthesized_from', 'concept-provenance' FROM pages c JOIN pages a ON a.source_id = c.source_id
        AND a.slug IN ('notes/n-' || (substr(c.slug, 9)::int - 2), 'notes/n-' || (substr(c.slug, 9)::int - 1))
      WHERE c.type = 'concept'`);
    // Each atom's origin was once renamed to a slug no page holds now, so no page changes visibility.
    // setupDB does not truncate slug_rename_history, so the rows are cleared here and in afterAll.
    await engine.executeRaw(`DELETE FROM slug_rename_history WHERE ${FIXTURE_HISTORY}`);
    await engine.executeRaw(`INSERT INTO slug_rename_history (source_id, old_slug, new_slug)
      SELECT source_id, frontmatter->>'source_slug', 'archive/' || slug FROM pages WHERE type = 'atom'`);
    await engine.executeRaw('ANALYZE links');
    await engine.executeRaw('ANALYZE slug_rename_history');
    const [{ links }] = await engine.executeRaw<{ links: number }>(`SELECT count(*)::int AS links FROM links WHERE link_source = 'concept-provenance'`);
    expect(links).toBe(Math.ceil((PAGES - 4) / 23) * 2);
    await expectSameHiddenPages();
    const { before, after, local, inline, budget } = await costPerPage();
    console.info(JSON.stringify({ metric: 'private-visibility-cost-per-page-analyzed', before, after, local, inline, budget }));
    if (before <= budget) throw new Error(`Precondition failed: the IN spelling already costs ${before} per page (budget ${budget}); this check cannot discriminate.`);
    expect(after).toBeLessThan(budget);
  });
});
