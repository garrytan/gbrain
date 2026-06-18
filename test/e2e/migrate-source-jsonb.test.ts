/**
 * E2E JSONB round-trip for cross-engine source migration.
 *
 * PGLite normalizes some stringified JSON values back into objects, so the
 * environment-faithful proof for this bug class needs a real Postgres target.
 *
 * Run: DATABASE_URL=... bun test test/e2e/migrate-source-jsonb.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { copySourceRowsForMigration } from '../../src/commands/migrate-engine.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E migrate-source JSONB round-trip test (DATABASE_URL not set)');
}

describeE2E('Postgres migrate-engine source copy config shape', () => {
  let source: PGLiteEngine;

  beforeAll(async () => {
    await setupDB();
    source = new PGLiteEngine();
    await source.connect({});
    await source.initSchema();
  });

  afterAll(async () => {
    await source.disconnect();
    await teardownDB();
  });

  test('copySourceRowsForMigration writes config as an object, not a JSONB string', async () => {
    const target = getEngine();
    const conn = getConn();

    await source.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
         VALUES ('wiki', 'Wiki', '/tmp/wiki', '{"federated": true, "k": "v"}'::jsonb)`,
    );

    await copySourceRowsForMigration(source, target);

    const rows = await conn.unsafe(`
      SELECT
        jsonb_typeof(config) AS jt,
        config->>'federated' AS federated,
        config->>'k' AS k
      FROM sources
      WHERE id = 'wiki'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].jt).toBe('object');
    expect(rows[0].federated).toBe('true');
    expect(rows[0].k).toBe('v');
  }, 60_000);
});
