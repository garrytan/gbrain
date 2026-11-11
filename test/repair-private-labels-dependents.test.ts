/**
 * GST-2374: the private-labels dependents statement (dependentsSql) returns exactly the rows the pre-change statement
 * returned, on PGLite, over a repo-less fixture holding every tie the remote privacy rules follow from a cleared page.
 * The same comparison runs on Postgres in test/e2e/repair-private-labels-dependents-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dependentsSql } from '../src/core/repair/private-labels.ts';
import { __resetPrivateVisibilityCacheForTests, readHonorAliases } from '../src/core/search/private-visibility.ts';
import { EXPECTED, named, preChangeDependentsSql, seedDependentsFixture, seedGeneratedSource, type DependentRow, type DependentsFixture } from './helpers/private-labels-dependents-fixture.ts';

let engine: PGLiteEngine;
let fixture: DependentsFixture;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  fixture = await seedDependentsFixture(engine);
  await readHonorAliases(engine);
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

const run = async (sql: string, params: unknown[]) => engine.executeRaw<DependentRow>(sql, params);

describe('private-labels dependents statement (PGLite)', () => {
  test('a window of every cleared page returns the pre-change rows, and those are the expected ties', async () => {
    const before = named(await run(preChangeDependentsSql(), fixture.params), fixture.name);
    expect(named(await run(dependentsSql(), fixture.params), fixture.name)).toEqual(before);
    expect(before).toEqual([...EXPECTED].sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1)));
  });

  test('a window of each cleared page alone returns the pre-change rows', async () => {
    const ids = fixture.params[0] as number[];
    for (let i = 0; i < ids.length; i++) {
      const one = fixture.params.map(list => [(list as unknown[])[i]]);
      expect(named(await run(dependentsSql(), one), fixture.name)).toEqual(named(await run(preChangeDependentsSql(), one), fixture.name));
    }
  });

  test('a generated source of 600 pages and a 40-page window returns the pre-change rows', async () => {
    const params = await seedGeneratedSource(engine, 'dep-gen', 600, 40);
    const before = await run(preChangeDependentsSql(), params);
    expect(before.length).toBeGreaterThan(80);
    expect(named(await run(dependentsSql(), params), new Map())).toEqual(named(before, new Map()));
  }, 120_000);

  test('with privacy aliases off, the rows still match the pre-change statement', async () => {
    await engine.setConfig('visibility.honor_aliases', 'false');
    try {
      __resetPrivateVisibilityCacheForTests();
      await readHonorAliases(engine);
      const before = named(await run(preChangeDependentsSql(), fixture.params), fixture.name);
      expect(before).not.toContainEqual(['dep-a:events/e6', 'dep-a:meetings/m6', 'life_chronicle']);
      expect(named(await run(dependentsSql(), fixture.params), fixture.name)).toEqual(before);
    } finally {
      await engine.setConfig('visibility.honor_aliases', 'true');
      __resetPrivateVisibilityCacheForTests();
      await readHonorAliases(engine);
    }
  });
});
