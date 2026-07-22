/**
 * v0.38 engine.listAllSources + updateSourceConfig integration tests (PGLite).
 *
 * Runs against an in-memory PGLite engine so the test is hermetic (no
 * DATABASE_URL required). Postgres parity is covered by the e2e suite.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedSource(
  id: string,
  opts: { local_path?: string | null; archived?: boolean; config?: Record<string, unknown> } = {},
): Promise<void> {
  const localPath = opts.local_path === undefined ? `/tmp/${id}` : opts.local_path;
  const archived = opts.archived === true;
  const config = JSON.stringify(opts.config ?? {});
  // ON CONFLICT to make the seed idempotent in case the test bed re-seeds 'default'.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
     ON CONFLICT (id) DO UPDATE
       SET local_path = EXCLUDED.local_path,
           config = EXCLUDED.config,
           archived = EXCLUDED.archived`,
    [id, id, localPath, config, archived],
  );
}

describe('engine.listAllSources', () => {
  test('returns empty array on fresh brain with only seeded default', async () => {
    // 'default' source seeded by migration; we'll just check it appears
    const all = await engine.listAllSources();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.some(s => s.id === 'default')).toBe(true);
  });

  test('filters archived by default', async () => {
    await seedSource('alive');
    await seedSource('dead', { archived: true });
    const all = await engine.listAllSources();
    expect(all.some(s => s.id === 'alive')).toBe(true);
    expect(all.some(s => s.id === 'dead')).toBe(false);
  });

  test('includeArchived: true returns archived rows too', async () => {
    await seedSource('alive');
    await seedSource('dead', { archived: true });
    const all = await engine.listAllSources({ includeArchived: true });
    expect(all.some(s => s.id === 'alive')).toBe(true);
    expect(all.some(s => s.id === 'dead')).toBe(true);
  });

  test('localPathOnly: true filters local_path IS NULL (codex P1-4)', async () => {
    await seedSource('with-path', { local_path: '/tmp/x' });
    await seedSource('db-only', { local_path: null });
    const all = await engine.listAllSources({ localPathOnly: true });
    expect(all.some(s => s.id === 'with-path')).toBe(true);
    expect(all.some(s => s.id === 'db-only')).toBe(false);
  });

  test('config JSONB parses to object (autopilot reads last_full_cycle_at)', async () => {
    await seedSource('fred', { config: { last_full_cycle_at: '2026-05-22T07:00:00.000Z', remote_url: 'https://x' } });
    const all = await engine.listAllSources();
    const fred = all.find(s => s.id === 'fred')!;
    expect(fred.config.last_full_cycle_at).toBe('2026-05-22T07:00:00.000Z');
    expect(fred.config.remote_url).toBe('https://x');
  });

  test('default source sorts first', async () => {
    await seedSource('zebra');
    await seedSource('alpha');
    const all = await engine.listAllSources();
    expect(all[0].id).toBe('default');
  });
});

describe('engine.updateSourceConfig', () => {
  test('returns false for unknown source', async () => {
    const updated = await engine.updateSourceConfig('does-not-exist', { last_full_cycle_at: 'x' });
    expect(updated).toBe(false);
  });

  test('returns true and merges patch into config JSONB', async () => {
    await seedSource('alpha', { config: { existing: 'keep-me', remote_url: 'https://x' } });
    const updated = await engine.updateSourceConfig('alpha', { last_full_cycle_at: '2026-05-22T08:00:00.000Z' });
    expect(updated).toBe(true);
    const all = await engine.listAllSources();
    const a = all.find(s => s.id === 'alpha')!;
    expect(a.config.existing).toBe('keep-me');
    expect(a.config.remote_url).toBe('https://x');
    expect(a.config.last_full_cycle_at).toBe('2026-05-22T08:00:00.000Z');
  });

  test('patch overwrites same-key value (last-write-wins per JSONB ||)', async () => {
    await seedSource('beta', { config: { last_full_cycle_at: '2026-01-01T00:00:00.000Z' } });
    await engine.updateSourceConfig('beta', { last_full_cycle_at: '2026-05-22T09:00:00.000Z' });
    const all = await engine.listAllSources();
    expect(all.find(s => s.id === 'beta')!.config.last_full_cycle_at).toBe('2026-05-22T09:00:00.000Z');
  });

  test('idempotent: repeat write of same patch is a no-op semantically', async () => {
    await seedSource('charlie');
    await engine.updateSourceConfig('charlie', { last_full_cycle_at: '2026-05-22T10:00:00.000Z' });
    await engine.updateSourceConfig('charlie', { last_full_cycle_at: '2026-05-22T10:00:00.000Z' });
    const all = await engine.listAllSources();
    expect(all.find(s => s.id === 'charlie')!.config.last_full_cycle_at).toBe('2026-05-22T10:00:00.000Z');
  });

  test('COALESCE defense: works on source with empty config (the v0.38 fresh shape)', async () => {
    // Schema enforces config JSONB NOT NULL DEFAULT '{}', so we cannot
    // produce a row with NULL config here. The COALESCE in
    // updateSourceConfig is defensive against pre-migration brains whose
    // sources table predates the NOT NULL constraint. This case just
    // confirms the happy-path on the default empty config.
    await seedSource('delta', { config: {} });
    const updated = await engine.updateSourceConfig('delta', { last_full_cycle_at: '2026-05-22T11:00:00.000Z' });
    expect(updated).toBe(true);
    const all = await engine.listAllSources();
    expect(all.find(s => s.id === 'delta')!.config.last_full_cycle_at).toBe('2026-05-22T11:00:00.000Z');
  });

  // IS JSON guard: the postgres-engine atomic merge gates its `::jsonb` cast
  // behind the SQL `IS JSON` predicate so a historical bad row whose config is
  // a JSONB string of NON-JSON text normalizes to `{}` instead of raising
  // `invalid input syntax for type json` and aborting the UPDATE.
  //
  // We exercise the SQL CASE expression directly via executeRaw against PGLite
  // (which ships Postgres 17 + IS JSON parity) rather than calling
  // PostgresEngine.updateSourceConfig (which requires a live Postgres pool).
  test('IS-JSON guard: non-JSON string config normalizes to {} on merge', async () => {
    const patch = { merged_key: 'v' };

    const guarded = (configExpr: string) => `
      SELECT (
        CASE
          WHEN jsonb_typeof(${configExpr}) = 'object' THEN ${configExpr}
          WHEN jsonb_typeof(${configExpr}) = 'string'
            THEN CASE
              WHEN (${configExpr} #>> '{}') IS JSON
                THEN COALESCE(NULLIF((${configExpr} #>> '{}'), '')::jsonb, '{}'::jsonb)
              ELSE '{}'::jsonb
            END
          WHEN jsonb_typeof(${configExpr}) = 'array'
            THEN COALESCE(
              (SELECT jsonb_object_agg(kv.key, kv.value)
                 FROM jsonb_array_elements(${configExpr}) elem,
                      jsonb_each(elem) kv),
              '{}'::jsonb
            )
          ELSE '{}'::jsonb
        END || $1::jsonb
      ) AS result`;

    // 1. JSONB string holding NON-JSON text → normalizes to {} then merges patch.
    const bad = await engine.executeRaw<{ result: Record<string, unknown> }>(
      guarded(`to_jsonb('garbage text'::text)`),
      [JSON.stringify(patch)],
    );
    expect(bad[0].result).toEqual({ merged_key: 'v' });

    // 2. JSONB string holding double-encoded valid JSON object → parsed + merged.
    const good = await engine.executeRaw<{ result: Record<string, unknown> }>(
      guarded(`to_jsonb('{"x":1}'::text)`),
      [JSON.stringify(patch)],
    );
    expect(good[0].result).toEqual({ x: 1, merged_key: 'v' });
  });
});
