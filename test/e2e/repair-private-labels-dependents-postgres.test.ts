/**
 * GST-2374: the private-labels dependents statement (dependentsSql) on Postgres.
 *
 *   1. it returns exactly the rows the pre-change statement returned, over the repo-less fixture holding every tie the
 *      remote privacy rules follow from a cleared page, for the whole window and for each cleared page alone;
 *   2. the same over a generated source of 4,000 pages with a 250-page window;
 *   3. on a generated source of 50,000 pages with a 1,000-page window it finishes inside 20 s. The pre-change
 *      statement paired every page of the source with every cleared page (50 million pairs here) and took longer
 *      than its 120 s bound on a source with a few hundred thousand pages.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { dependentsSql } from '../../src/core/repair/private-labels.ts';
import { readHonorAliases } from '../../src/core/search/private-visibility.ts';
import { EXPECTED, named, preChangeDependentsSql, seedDependentsFixture, seedGeneratedSource, type DependentRow, type DependentsFixture } from '../helpers/private-labels-dependents-fixture.ts';

let fixture: DependentsFixture;
const run = (sql: string, params: unknown[], timeoutMs = 120_000) => getEngine().executeRaw<DependentRow>(sql, params, { timeoutMs, jitOff: true, prepare: false });

(hasDatabase() ? describe : describe.skip)('private-labels dependents statement (Postgres)', () => {
  beforeAll(async () => {
    await setupDB();
    fixture = await seedDependentsFixture(getEngine());
    await readHonorAliases(getEngine());
  }, 120_000);

  afterAll(async () => { await teardownDB(); });

  test('the fixture window returns the pre-change rows, whole and one cleared page at a time', async () => {
    const before = named(await run(preChangeDependentsSql(), fixture.params), fixture.name);
    expect(named(await run(dependentsSql(), fixture.params), fixture.name)).toEqual(before);
    expect(before).toEqual([...EXPECTED].sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1)));
    const ids = fixture.params[0] as number[];
    for (let i = 0; i < ids.length; i++) {
      const one = fixture.params.map(list => [(list as unknown[])[i]]);
      expect(named(await run(dependentsSql(), one), fixture.name)).toEqual(named(await run(preChangeDependentsSql(), one), fixture.name));
    }
  });

  test('a generated source of 4,000 pages and a 250-page window returns the pre-change rows', async () => {
    const params = await seedGeneratedSource(getEngine(), 'dep-gen', 4_000, 250);
    await getEngine().executeRaw('ANALYZE pages');
    const before = await run(preChangeDependentsSql(), params);
    expect(before.length).toBeGreaterThan(500);
    expect(named(await run(dependentsSql(), params), new Map())).toEqual(named(before, new Map()));
  }, 180_000);

  test('a generated source of 50,000 pages and a 1,000-page window finishes inside 20 s', async () => {
    const params = await seedGeneratedSource(getEngine(), 'dep-scale', 50_000, 1_000);
    await getEngine().executeRaw('ANALYZE pages');
    await getEngine().executeRaw('ANALYZE links');
    const rows = await run(dependentsSql(), params, 20_000);
    expect(new Set(rows.map(row => Number(row.cleared_id))).size).toBeGreaterThan(900);
  }, 300_000);
});
