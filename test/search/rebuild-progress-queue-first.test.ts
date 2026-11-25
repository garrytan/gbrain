/**
 * #10367: the rebuild-progress check joined the queue to `sources` on incarnation and filtered by slug
 * afterwards, so with a source list and the private-page filter Postgres paired every queue row with every
 * page of the sources (63M pairs, ~4 s per search) while only image rows sat in the queue. The queue is now
 * read first, on its own, and its few rows are paired with pages by (source_id, slug).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { countProjectionRebuild } from '../../src/core/search/retrieval-coverage.ts';

describe('rebuild progress reads the queue first', () => {
  let engine: PGLiteEngine;
  let sql = '';

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const run = engine.executeRaw.bind(engine);
    engine.executeRaw = (async (s: string, p?: unknown[], o?: never) => { sql = s; return run(s, p, o); }) as typeof engine.executeRaw;
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('the queue is a materialized read of its own and pages join it by source id and slug', async () => {
    const result = await countProjectionRebuild(engine, { sourceIds: ['default'], excludePrivate: true });
    expect(result).toBeNull();
    expect(sql).toMatch(/queued AS MATERIALIZED \(SELECT[^)]*page_projection_jobs/);
    expect(sql).toMatch(/JOIN pages p ON p\.source_id = j\.source_id AND p\.slug = j\.slug/);
  });
});
