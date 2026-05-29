/**
 * v0.38 — Postgres parity for listAllSources + updateSourceConfig.
 *
 * The PGLite implementations have unit-level coverage in
 * test/list-all-sources.test.ts (in-memory). This E2E pins Postgres
 * parity since the two engines have separate impls:
 *   - postgres-engine.ts uses postgres-js's sql.json + sql.count
 *   - pglite-engine.ts uses positional params + result.rows.length
 *
 * If the wire-protocol semantics diverge between engines (which has
 * happened — codex finding #861 / #876 hit this exact bug class on
 * a different field), this test catches it.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;

beforeAll(async () => {
  if (skip) return;
  engine = (await setupDB()) as PostgresEngine;
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

beforeEach(async () => {
  if (skip) return;
  // Clean source rows between tests, preserve 'default'
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
});

async function seedSource(
  id: string,
  opts: { local_path?: string | null; archived?: boolean; config?: Record<string, unknown> } = {},
): Promise<void> {
  const localPath = opts.local_path === undefined ? `/tmp/${id}` : opts.local_path;
  const archived = opts.archived === true;
  // NOTE: do NOT use executeRaw + `JSON.stringify(config) + $N::jsonb` —
  // postgres-js double-encodes the JS string parameter, producing a JSONB
  // STRING shape instead of OBJECT. Use sql.json() inside the template tag.
  // Same pattern as putPage. The pre-existing sources.ts:482 has the
  // same latent bug; the call site there is rare (gbrain sources
  // federate/unfederate) and out of scope for this PR.
  const eng = engine as unknown as { sql: (...args: unknown[]) => Promise<{ count?: number }> };
  await (eng.sql as any)`
    INSERT INTO sources (id, name, local_path, config, archived, created_at)
    VALUES (${id}, ${id}, ${localPath}, ${(eng.sql as any).json(opts.config ?? {})}, ${archived}, NOW())
    ON CONFLICT (id) DO UPDATE
      SET local_path = EXCLUDED.local_path,
          config = EXCLUDED.config,
          archived = EXCLUDED.archived
  `;
}

describeIfDB('Postgres parity — listAllSources', () => {
  test('returns rows including default + seeded', async () => {
    await seedSource('alpha');
    const all = await engine.listAllSources();
    expect(all.some(s => s.id === 'default')).toBe(true);
    expect(all.some(s => s.id === 'alpha')).toBe(true);
  });

  test('filters archived by default', async () => {
    await seedSource('alive');
    await seedSource('dead', { archived: true });
    const all = await engine.listAllSources();
    expect(all.some(s => s.id === 'alive')).toBe(true);
    expect(all.some(s => s.id === 'dead')).toBe(false);
  });

  test('includeArchived: true returns archived rows', async () => {
    await seedSource('alive');
    await seedSource('dead', { archived: true });
    const all = await engine.listAllSources({ includeArchived: true });
    expect(all.some(s => s.id === 'dead')).toBe(true);
  });

  test('localPathOnly filters NULL local_path (codex P1-4)', async () => {
    await seedSource('with-path');
    await seedSource('db-only', { local_path: null });
    const all = await engine.listAllSources({ localPathOnly: true });
    expect(all.some(s => s.id === 'with-path')).toBe(true);
    expect(all.some(s => s.id === 'db-only')).toBe(false);
  });

  test('config JSONB parses to object (autopilot reads last_full_cycle_at)', async () => {
    await seedSource('fred', {
      config: { last_full_cycle_at: '2026-05-22T08:00:00.000Z', remote_url: 'https://x' },
    });
    const all = await engine.listAllSources();
    const fred = all.find(s => s.id === 'fred')!;
    expect(fred.config.last_full_cycle_at).toBe('2026-05-22T08:00:00.000Z');
    expect(fred.config.remote_url).toBe('https://x');
  });

  test('default source sorts first', async () => {
    await seedSource('zebra');
    await seedSource('alpha');
    const all = await engine.listAllSources();
    expect(all[0].id).toBe('default');
  });
});

describeIfDB('Postgres parity — updateSourceConfig', () => {
  test('returns false for unknown source', async () => {
    const updated = await engine.updateSourceConfig('no-such-source', { x: 1 });
    expect(updated).toBe(false);
  });

  test('returns true and merges patch into JSONB', async () => {
    await seedSource('alpha', { config: { keep: 'me' } });
    const updated = await engine.updateSourceConfig('alpha', {
      last_full_cycle_at: '2026-05-22T09:00:00.000Z',
    });
    expect(updated).toBe(true);
    const all = await engine.listAllSources();
    const a = all.find(s => s.id === 'alpha')!;
    expect(a.config.keep).toBe('me');
    expect(a.config.last_full_cycle_at).toBe('2026-05-22T09:00:00.000Z');
  });

  test('same-key overwrites (||  semantics)', async () => {
    await seedSource('beta', { config: { last_full_cycle_at: '2026-01-01T00:00:00.000Z' } });
    await engine.updateSourceConfig('beta', { last_full_cycle_at: '2026-05-22T10:00:00.000Z' });
    const all = await engine.listAllSources();
    expect(all.find(s => s.id === 'beta')!.config.last_full_cycle_at).toBe(
      '2026-05-22T10:00:00.000Z',
    );
  });

  test('repeat write is idempotent', async () => {
    await seedSource('charlie');
    await engine.updateSourceConfig('charlie', { last_full_cycle_at: '2026-05-22T11:00:00.000Z' });
    await engine.updateSourceConfig('charlie', { last_full_cycle_at: '2026-05-22T11:00:00.000Z' });
    const all = await engine.listAllSources();
    expect(all.find(s => s.id === 'charlie')!.config.last_full_cycle_at).toBe(
      '2026-05-22T11:00:00.000Z',
    );
  });

  test('round-trip stores real JSONB object, NOT a JSON-encoded string (jsonb_typeof regression)', async () => {
    await seedSource('delta');
    await engine.updateSourceConfig('delta', { last_full_cycle_at: '2026-05-22T12:00:00.000Z' });
    // Regression for the postgres.js v3 double-encode bug class
    // (feedback_postgres_jsonb_double_encode). If sql.json's serialization
    // produces a string-shaped JSONB column, jsonb_typeof returns 'string'
    // and `->>'last_full_cycle_at'` returns NULL (the key isn't inside an
    // object). The expected typeof is 'object'.
    const rows = await engine.executeRaw<{ typeof: string; value: string | null }>(
      `SELECT jsonb_typeof(config) AS typeof, config->>'last_full_cycle_at' AS value
         FROM sources WHERE id = 'delta'`,
    );
    expect(rows[0]?.typeof).toBe('object');
    expect(rows[0]?.value).toBe('2026-05-22T12:00:00.000Z');
  });
});
