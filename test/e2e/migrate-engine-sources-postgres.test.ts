import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { copyMigrationSources } from '../../src/commands/migrate-engine.ts';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';

const describePg = hasDatabase() ? describe : describe.skip;

describePg('migrate-engine source copy PGLite to Postgres', () => {
  let source: PGLiteEngine;

  beforeAll(async () => {
    await setupDB();
    source = new PGLiteEngine();
    await source.connect({});
    await source.initSchema();
  });

  afterAll(async () => {
    if (source) await source.disconnect();
    await teardownDB();
  });

  test('copies source parents before overlapping-slug pages', async () => {
    await source.executeRaw(`INSERT INTO sources (id, name, config)
      VALUES ('source-a', 'Source A', '{"federated":true}'::jsonb),
             ('source-b', 'Source B', '{"federated":false}'::jsonb)`);
    for (const sourceId of ['source-a', 'source-b']) {
      await source.putPage('people/shared', {
        type: 'person', title: sourceId, compiled_truth: sourceId,
      }, { sourceId });
    }

    const target = getEngine();
    await copyMigrationSources(source, target);
    for (const page of await source.listPages({ limit: 10 })) {
      await target.putPage(page.slug, {
        type: page.type, title: page.title, compiled_truth: page.compiled_truth,
      }, { sourceId: page.source_id });
    }

    expect(await target.getPage('people/shared', { sourceId: 'source-a' })).not.toBeNull();
    expect(await target.getPage('people/shared', { sourceId: 'source-b' })).not.toBeNull();
  });
});
