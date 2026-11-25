/**
 * The resolver's fallback reads and source checks (PGLite): an archived source never comes back as active through a
 * fallback, and checking one source does not parse another source's config.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveSourceId, resolveSourceWithTier } from '../src/core/source-resolver.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function seed(id: string, localPath: string | null, archived: boolean, config = '{}') {
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, archived, config) VALUES ($1, $1, $2, $3, $4::jsonb) ON CONFLICT (id) DO UPDATE SET local_path = $2, archived = $3, config = $4::jsonb`, [id, localPath, archived, config]);
}

describe('archived sources stay out of every fallback read', () => {
  test('listSourceRecords reports archived on a brain without newest_content_at', async () => {
    await seed('retired', '/vaults/retired', true);
    await engine.executeRaw('ALTER TABLE sources DROP COLUMN newest_content_at');
    const retired = (await engine.listSourceRecords()).find(row => row.id === 'retired');
    expect(retired?.archived).toBe(true);
    // Put the column back for the other tests in this file.
    await engine.executeRaw('ALTER TABLE sources ADD COLUMN newest_content_at TIMESTAMPTZ');
  });

  test('a failed routing read (a statement timeout) does not make bare resolution pick an archived source', async () => {
    await seed('default', null, false);
    await seed('retired', '/vaults/retired', true);
    const timingOut = new Proxy(engine, {
      get(target, key) {
        if (key === 'listSourceRoutingRows') return async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); };
        const value = (target as unknown as Record<PropertyKey, unknown>)[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const picked = await resolveSourceWithTier(timingOut, null, '/nowhere/in/particular');
    expect(picked.source_id).toBe('default');
    expect(picked.tier).toBe('seed_default');
  });
});

describe('checking one source reads only that source', () => {
  test('an explicit --source resolves when another source holds a config that is not JSON', async () => {
    await seed('healthy', '/vaults/healthy', false);
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('broken', 'broken', NULL, to_jsonb('not-json'::text))`);
    expect(await resolveSourceId(engine, 'healthy', '/nowhere/in/particular')).toBe('healthy');
  });
});
