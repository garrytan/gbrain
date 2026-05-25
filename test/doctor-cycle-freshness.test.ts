/**
 * v0.38 — doctor checkCycleFreshness unit test.
 *
 * Mirrors checkSyncFreshness shape: returns Check with status mapping to
 * per-source last_full_cycle_at from sources.config JSONB. Reads what
 * autopilot's per-source dispatch gate writes.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { checkCycleFreshness } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const NOW = Date.parse('2026-05-22T12:00:00.000Z');
const agoH = (h: number) => new Date(NOW - h * 3600_000).toISOString();

async function seed(id: string, lastFullCycleAt?: string, opts: { local_path?: string | null } = {}): Promise<void> {
  const config = lastFullCycleAt
    ? JSON.stringify({ last_full_cycle_at: lastFullCycleAt })
    : '{}';
  const localPath = opts.local_path === undefined ? `/tmp/${id}` : opts.local_path;
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, $4::jsonb, false, NOW())
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [id, id, localPath, config],
  );
}

describe('doctor checkCycleFreshness', () => {
  test('empty (no federated sources) returns ok', async () => {
    // resetPgliteState reseeds the default source with no local_path
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/No federated sources/);
  });

  test('source with last_full_cycle_at 2h ago returns ok (under 6h warn)', async () => {
    await seed('fresh', agoH(2));
    // default source also has no last_full_cycle_at — so we'd get a fail
    // unless default lacks local_path. resetPgliteState seeds default with
    // no local_path, so it's filtered. Confirm.
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('ok');
  });

  test('source with last_full_cycle_at 10h ago returns warn (>6h, <24h)', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('warned', agoH(10));
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/warned/);
    expect(result.message).toMatch(/10h ago/);
  });

  test('source with last_full_cycle_at 48h ago returns fail (>24h)', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('stale', agoH(48));
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/stale/);
    expect(result.message).toMatch(/gbrain dream --source/);
  });

  test('source with NO last_full_cycle_at (never cycled) returns fail', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('virgin');
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/never completed a full cycle/);
  });

  test('mixed sources: highest severity wins (fail > warn > ok)', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('fresh', agoH(1));     // ok
    await seed('warned', agoH(12));   // warn
    await seed('stale', agoH(72));    // fail
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('fail');
  });

  test('future last_full_cycle_at returns warn (clock skew)', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const future = new Date(NOW + 3600_000).toISOString();
    await seed('clock-skewed', future);
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/future last_full_cycle_at/);
  });

  test('unparseable last_full_cycle_at returns warn', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('garbled', 'not-an-iso-date');
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/unparseable/);
  });

  test('local_path NULL sources are filtered (codex P1-4 parity)', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('db-only', undefined, { local_path: null });
    // No federated sources to check; default is unsynced but filtered.
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/No federated sources/);
  });
});
