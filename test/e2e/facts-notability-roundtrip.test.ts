/**
 * v0.31.2 — facts notability column round-trip E2E (Postgres parity).
 *
 * Fills gap #4 from the test gap analysis: facts-engine.test.ts pins
 * notability round-trip on PGLite, but no test pins the same on
 * Postgres. The row mappers ARE different code on each engine
 * (postgres-engine.ts:rowToFactPg vs pglite-engine.ts:rowToFact). The
 * v46 migration E2E pins schema parity but not row-mapper parity.
 *
 * This test inserts facts with each notability tier on real Postgres
 * via PostgresEngine.insertFact, reads them back via the same engine's
 * listFactsByEntity, and asserts the notability tier survives the
 * write→read trip on the actual postgres.js driver.
 *
 * Gated by DATABASE_URL — skips otherwise.
 *
 * Run: DATABASE_URL=... bun test test/e2e/facts-notability-roundtrip.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  hasDatabase,
  setupDB,
  teardownDB,
  getEngine,
  runMigrationsUpTo,
  getConn,
} from './helpers.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping facts notability round-trip E2E (DATABASE_URL not set)');
}

describeE2E('facts notability column — Postgres row-mapper round-trip', () => {
  beforeAll(async () => {
    await setupDB();
    await runMigrationsUpTo(getEngine(), LATEST_VERSION);
  }, 30_000);

  afterAll(async () => {
    // Clean up any facts inserted by this file.
    const conn = getConn();
    await conn.unsafe(`DELETE FROM facts WHERE entity_slug LIKE 'notability-roundtrip-%'`);
    await teardownDB();
  });

  test('inserts a fact with notability=high and reads it back', async () => {
    const engine = getEngine();
    const r = await engine.insertFact(
      {
        fact: 'roundtrip high fact',
        kind: 'event',
        entity_slug: 'notability-roundtrip-high',
        source: 'test',
        notability: 'high',
      },
      { source_id: 'default' },
    );
    expect(r.status).toBe('inserted');

    const rows = await engine.listFactsByEntity('default', 'notability-roundtrip-high');
    const ours = rows.find(x => x.id === r.id);
    expect(ours).toBeDefined();
    expect(ours!.notability).toBe('high');
  });

  test('inserts a fact with notability=medium and reads it back', async () => {
    const engine = getEngine();
    const r = await engine.insertFact(
      {
        fact: 'roundtrip medium fact',
        kind: 'preference',
        entity_slug: 'notability-roundtrip-medium',
        source: 'test',
        notability: 'medium',
      },
      { source_id: 'default' },
    );

    const rows = await engine.listFactsByEntity('default', 'notability-roundtrip-medium');
    const ours = rows.find(x => x.id === r.id);
    expect(ours!.notability).toBe('medium');
  });

  test('inserts a fact with notability=low and reads it back', async () => {
    const engine = getEngine();
    const r = await engine.insertFact(
      {
        fact: 'roundtrip low fact',
        kind: 'fact',
        entity_slug: 'notability-roundtrip-low',
        source: 'test',
        notability: 'low',
      },
      { source_id: 'default' },
    );

    const rows = await engine.listFactsByEntity('default', 'notability-roundtrip-low');
    const ours = rows.find(x => x.id === r.id);
    expect(ours!.notability).toBe('low');
  });

  test('omitting notability defaults to medium', async () => {
    const engine = getEngine();
    const r = await engine.insertFact(
      {
        fact: 'roundtrip default-tier fact',
        kind: 'fact',
        entity_slug: 'notability-roundtrip-default',
        source: 'test',
      },
      { source_id: 'default' },
    );

    const rows = await engine.listFactsByEntity('default', 'notability-roundtrip-default');
    const ours = rows.find(x => x.id === r.id);
    expect(ours!.notability).toBe('medium');
  });

  test('listFactsSince also surfaces notability', async () => {
    const engine = getEngine();
    const since = new Date(Date.now() - 60_000);
    const rows = await engine.listFactsSince('default', since);
    // Filter to our test rows.
    const ours = rows.filter(r => r.entity_slug?.startsWith('notability-roundtrip-'));
    expect(ours.length).toBeGreaterThanOrEqual(3);
    for (const r of ours) {
      expect(['high', 'medium', 'low']).toContain(r.notability);
    }
  });
});
