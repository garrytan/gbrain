import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncFreshness } from '../src/commands/doctor.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const NOW = Date.parse('2026-05-22T12:00:00.000Z');
const agoH = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();

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

async function seed(id: string, config: unknown, lastSyncAt: string | null = null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, last_sync_at)
     VALUES ($1, $1, $2, $3::text::jsonb, $4)`,
    [id, `/example/${id}`, JSON.stringify(config), lastSyncAt],
  );
}

describe('doctor sync freshness honors automatic sync policy', () => {
  for (const config of [{ syncEnabled: false }, JSON.stringify({ syncEnabled: false })]) {
    for (const localOnly of [false, true]) {
      test(`excludes never-synced and stale disabled sources (${typeof config}, localOnly=${localOnly})`, async () => {
        await seed('disabled-never', config);
        await seed('disabled-stale', config, agoH(120));
        const result = await checkSyncFreshness(engine, { nowMs: NOW, localOnly });
        expect(result.status).toBe('ok');
        expect(result.message).toBe('No federated sources to sync');
        expect(result.details).toEqual({ unchanged_count: 0, synced_recently_count: 0, stale_count: 0 });
      });
    }
  }

  test('mixed sources keep enabled failures and count only sync-eligible sources', async () => {
    await seed('disabled-example', { syncEnabled: false });
    await seed('stale-example', { syncEnabled: true }, agoH(120));
    await seed('fresh-example', {}, agoH(1));
    const result = await checkSyncFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('fail');
    expect(result.message).toContain("'stale-example'");
    expect(result.message).not.toContain('disabled-example');
    expect(result.details).toEqual({ unchanged_count: 0, synced_recently_count: 1, stale_count: 1 });
  });

  test.each([
    { syncEnabled: true },
    JSON.stringify({ syncEnabled: true }),
    {},
    null,
    'invalid-json',
    { syncEnabled: 'false' },
  ])('only boolean false disables sync (%j)', async (config) => {
    await seed('enabled-example', config);
    const result = await checkSyncFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('fail');
    expect(result.message).toContain("'enabled-example' has never been synced");
    expect(result.details).toEqual({ unchanged_count: 0, synced_recently_count: 0, stale_count: 1 });
  });

  test('legacy archived-column fallback also loads and honors config', async () => {
    await seed('disabled-example', { syncEnabled: false });
    let usedFallback = false;
    const legacyEngine = {
      executeRaw: async (sql: string) => {
        if (sql.includes('archived IS NOT TRUE')) throw new Error('column archived does not exist');
        usedFallback = true;
        return engine.executeRaw(sql);
      },
    } as unknown as BrainEngine;
    const result = await checkSyncFreshness(legacyEngine, { nowMs: NOW });
    expect(usedFallback).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.details).toEqual({ unchanged_count: 0, synced_recently_count: 0, stale_count: 0 });
  });
});
