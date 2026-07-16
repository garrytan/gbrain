import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { reconcileStructure, DERIVED_PATH_SOURCE } from '../../src/core/structure-reconcile.ts';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
let engine: PostgresEngine;

run('structural reconciliation on PostgreSQL', () => {
  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw(`
      TRUNCATE links, content_chunks, timeline_entries, tags, page_versions,
        raw_data, ingest_log, pages RESTART IDENTITY CASCADE
    `);
  });

  test('writes source-qualified derived edges transactionally', async () => {
    await engine.putPage('docs/readme', {
      type: 'note', title: 'Docs', compiled_truth: 'docs index', frontmatter: {},
    });
    await engine.putPage('docs/guide', {
      type: 'note', title: 'Guide', compiled_truth: 'guide', frontmatter: {},
    });
    const result = await reconcileStructure(engine);
    expect(result.edges_written).toBe(result.edges_planned);
    expect(result.max_degree).toBeLessThanOrEqual(64);
    expect((await engine.getHealth()).orphan_pages).toBe(0);
    const provenance = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM links WHERE link_source=$1`,
      [DERIVED_PATH_SOURCE],
    );
    expect(Number(provenance[0].count)).toBe(result.edges_planned);
  });
});
