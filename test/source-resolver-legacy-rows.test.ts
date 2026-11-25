/**
 * The resolver's fallback reads and source checks (PGLite): an archived source never comes back as active through a
 * fallback, and checking one source does not parse another source's config.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __resetSourceGuardQueryShape, resolveSourceId, resolveSourceWithTier, sourceGuardBlocksWrite } from '../src/core/source-resolver.ts';
import { sourceHasRepo } from '../src/core/search/ignored-privacy-labels.ts';
import { PRIVACY_LABEL_KEYS } from '../src/core/search/ignored-privacy-labels.ts';
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

describe('the typed reads the import path asks for', () => {
  test('listActiveSourceConfigs returns the active sources by id with their raw config', async () => {
    await seed('beta', null, false, '{"federated": true}');
    await seed('alpha', null, false);
    await seed('retired', null, true);
    const rows = await engine.listActiveSourceConfigs();
    expect(rows.map(row => row.id)).toEqual(['alpha', 'beta', 'default']);
    expect(rows.every(row => row.archived === false)).toBe(true);
    expect(rows.find(row => row.id === 'beta')?.config).toEqual({ federated: true });
  });

  test('ownsSchemaTables is true for the role that created the schema', async () => {
    expect(await engine.ownsSchemaTables()).toBe(true);
  });

  test('readSourceIncarnation answers a source\'s config and incarnation, and null for an unknown id', async () => {
    await seed('known', null, false, '{"federated": true}');
    const row = await engine.readSourceIncarnation('known');
    expect(row?.config).toEqual({ federated: true });
    expect(row?.incarnation).toMatch(/^[0-9a-f-]{36}$/);
    expect(await engine.readSourceIncarnation('unknown-source')).toBeNull();
  });

  test('readLivePageFrontmatter answers the stored type and frontmatter of a live page, and null otherwise', async () => {
    await engine.putPage('notes/frontmatter-read', { type: 'note', title: 'Frontmatter read', compiled_truth: 'Body.', frontmatter: { topic: 'reads' } });
    const page = await engine.readLivePageFrontmatter('default', 'notes/frontmatter-read');
    expect({ type: page?.type, topic: page?.frontmatter?.topic }).toEqual({ type: 'note', topic: 'reads' });
    expect(await engine.readLivePageFrontmatter('default', 'notes/absent')).toBeNull();
  });

  test('readIgnoredPrivacyLabelPages returns only the pages that carry an ignored privacy label', async () => {
    const key = PRIVACY_LABEL_KEYS[0]!;
    await engine.putPage('notes/labelled', { type: 'note', title: 'Labelled', compiled_truth: 'Body.', frontmatter: { [key]: 'personal' } });
    await engine.putPage('notes/plain', { type: 'note', title: 'Plain', compiled_truth: 'Body.', frontmatter: { topic: 'reads' } });
    const rows = await engine.readIgnoredPrivacyLabelPages('default', { slugs: ['notes/labelled', 'notes/plain'] });
    expect(rows.map(row => row.frontmatter?.[key])).toEqual(['personal']);
  });

  test('readWriterAdminState reports the brain, its sources and the legacy locks as one JSON document', async () => {
    await seed('admin-state', null, false);
    const state = JSON.parse(await engine.readWriterAdminState()) as { brain: unknown; sources: Array<[string, ...unknown[]]>; legacy_locks: unknown };
    expect(Object.keys(state).sort()).toEqual(['bindings', 'brain', 'fallback', 'hosts', 'legacy_locks', 'sources', 'worktrees']);
    expect(state.sources.map(row => row[0])).toContain('admin-state');
  });
});

describe('the three fault paths the final review reproduced', () => {
  const timingOut = () => new Proxy(engine, {
    get(target, key) {
      if (key === 'listSourceRoutingRows') return async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); };
      const value = (target as unknown as Record<PropertyKey, unknown>)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  test('a failed routing read does not route a bare command to a storage_manifest source', async () => {
    await seed('default', null, false);
    await seed('shelf', '/vaults/shelf', false, '{"role": "storage_manifest"}');
    const picked = await resolveSourceWithTier(timingOut(), null, '/nowhere/in/particular');
    expect({ source: picked.source_id, tier: picked.tier }).toEqual({ source: 'default', tier: 'seed_default' });
  });

  test('sourceHasRepo reads the source with the notice bound, and gives up on a config read that does not answer', async () => {
    let boundSeen: number | undefined;
    const stub = {
      getSource: async (_id: string, opts?: { timeoutMs?: number }) => { boundSeen = opts?.timeoutMs; return { id: 'default', local_path: null, config: {} }; },
      getConfig: () => new Promise<string | null>(() => {}),
    } as unknown as Parameters<typeof sourceHasRepo>[0];
    const started = Date.now();
    const answer = await sourceHasRepo(stub, 'default');
    expect({ boundSeen, answer, quick: Date.now() - started < 3000 }).toEqual({ boundSeen: 1000, answer: true, quick: true });
  });

  test('sourceHasRepo reads a config that is not JSON as a source with no repository', async () => {
    const stub = { getSource: async () => ({ id: 'plain', local_path: null, config: 'not-json' }), getConfig: async () => null } as unknown as Parameters<typeof sourceHasRepo>[0];
    expect(await sourceHasRepo(stub, 'plain')).toBe(false);
  });

  test('one source whose config is not JSON does not make a sole-source write look ambiguous', async () => {
    __resetSourceGuardQueryShape();
    await seed('default', null, false);
    await engine.executeRaw(`UPDATE sources SET config = to_jsonb('not-json'::text) WHERE id = 'default'`);
    expect(await sourceGuardBlocksWrite(engine, 'seed_default')).toBe(false);
    await seed('second', null, false);
    expect(await sourceGuardBlocksWrite(engine, 'seed_default')).toBe(true);
  });
});
