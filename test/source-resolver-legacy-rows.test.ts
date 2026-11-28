/**
 * The resolver's fallback reads and source checks (PGLite): an archived source never comes back as active through a
 * fallback, and checking one source does not parse another source's config.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __resetSourceGuardQueryShape, explicitReadBinding, getDefaultSourcePath, resolveRegisteredLocalPathSource, resolveSourceId, resolveSourceWithTier, sourceGuardBlocksWrite } from '../src/core/source-resolver.ts';
import { ownerSourceGateInput } from '../src/core/trust/channel.ts';
import { sourceHasRepo } from '../src/core/search/ignored-privacy-labels.ts';
import { PRIVACY_LABEL_KEYS } from '../src/core/search/ignored-privacy-labels.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { withRequestConfigSnapshot } from '../src/core/config-snapshot.ts';

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

  test('sourceHasRepo reads the source and the repo path with the notice bound, so the database ends a stalled read', async () => {
    const bounds: Array<number | undefined> = [];
    const stub = {
      getSource: async (_id: string, opts?: { timeoutMs?: number }) => { bounds.push(opts?.timeoutMs); return { id: 'default', local_path: null, config: {} }; },
      getConfig: async (_key: string, opts?: { timeoutMs?: number }) => { bounds.push(opts?.timeoutMs); return null; },
    } as unknown as Parameters<typeof sourceHasRepo>[0];
    expect({ answer: await sourceHasRepo(stub, 'default'), bounds }).toEqual({ answer: false, bounds: [1000, 1000] });
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

describe('a brain older than the source columns the import path does not need', () => {
  // A brain of its own: the columns are dropped for good, so no other test in this file sees them gone.
  let old: PGLiteEngine;
  beforeAll(async () => {
    old = new PGLiteEngine();
    await old.connect({});
    await old.initSchema();
    await old.executeRaw('ALTER TABLE sources DROP COLUMN IF EXISTS contextual_retrieval_mode');
    await old.executeRaw('ALTER TABLE sources DROP COLUMN IF EXISTS trust_frontmatter_overrides');
    await old.executeRaw(`UPDATE sources SET local_path = '/vaults/default', config = '{"trust": {"frontmatter_overrides": false}}'::jsonb WHERE id = 'default'`);
  }, 60_000);
  afterAll(async () => { await old.disconnect(); });

  test('getDefaultSourcePath reads a source path from a brain without the contextual-retrieval and trust-override columns', async () => {
    // GBRAIN_SOURCE names the source, so the chain lists no registered paths and the source's own row is read.
    expect(await withEnv({ GBRAIN_SOURCE: 'default' }, () => getDefaultSourcePath(old, '/nowhere/in/particular'))).toBe('/vaults/default');
  });

  test('the import trust gate reads the source config from a brain without those columns', async () => {
    const gate = await ownerSourceGateInput(old, 'default', {});
    expect(gate.origin.channel).toBe('import');
  });
});

describe('the oldest source projection (neither newest_content_at nor archived)', () => {
  let oldest: PGLiteEngine;
  beforeAll(async () => {
    oldest = new PGLiteEngine();
    await oldest.connect({});
    await oldest.initSchema();
    await oldest.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('shelf', 'shelf', '/vaults/shelf') ON CONFLICT DO NOTHING`);
    await oldest.executeRaw('ALTER TABLE sources DROP COLUMN newest_content_at');
    await oldest.executeRaw('ALTER TABLE sources DROP COLUMN archived');
  }, 60_000);
  afterAll(async () => { await oldest.disconnect(); });

  test('listSourceRecords returns every source with the historical columns, `archived` absent', async () => {
    const rows = await oldest.listSourceRecords();
    expect(rows.map(row => row.id)).toEqual(['default', 'shelf']);
    expect(rows.every(row => row.archived === undefined)).toBe(true);
  });

  test('bare resolution on that brain sees the sole other source through the minimal projection', async () => {
    __resetSourceGuardQueryShape();
    expect(await sourceGuardBlocksWrite(oldest, 'seed_default')).toBe(true);
  });

  test('a failure that is not a missing column is not read as an older schema', async () => {
    const boom = Object.assign(new Error('permission denied for table sources'), { code: '42501' });
    const failing = new Proxy(oldest, { get(target, key) {
      if (key === 'executeRaw') return async () => { throw boom; };
      const value = (target as unknown as Record<PropertyKey, unknown>)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const error = await PGLiteEngine.prototype.listSourceRecords.call(failing).then(() => null, (e: unknown) => e);
    expect(error).toBe(boom);
  });
});

describe('a typed capability refusal is not an older brain', () => {
  const refusal = () => Object.assign(new Error('engine_capability_missing: listLocalPathSources'), { code: 'engine_capability_missing' });
  const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

  /** The engine with `member` failing as `fail()` says, and the calls of the members a legacy fallback would make counted. */
  function failing(member: string, fail: () => Error) {
    const calls: string[] = [];
    const view = new Proxy(engine, {
      get(target, key) {
        if (key === member) return async () => { throw fail(); };
        const value = (target as unknown as Record<PropertyKey, unknown>)[key];
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { calls.push(String(key)); return (value as (...a: unknown[]) => unknown).apply(target, args); };
      },
    }) as unknown as PGLiteEngine;
    return { view, calls };
  }

  test('the local-path listing refuses through resolution and does not fall back to the legacy rows', async () => {
    const { view, calls } = failing('listLocalPathSources', refusal);
    const error = await resolveRegisteredLocalPathSource(view, '/vaults/x').then(() => null, (e: unknown) => e);
    expect((error as { code?: string } | null)?.code).toBe('engine_capability_missing');
    expect(calls).not.toContain('listSourceRecords');
  });

  test('the same listing failing on a timeout does fall back to the legacy rows', async () => {
    await seed('shelf', '/vaults/shelf', false);
    const { view, calls } = failing('listLocalPathSources', timeout);
    expect(await resolveRegisteredLocalPathSource(view, '/vaults/shelf/deep')).toBe('shelf');
    expect(calls).toContain('listSourceRecords');
  });

  test('the request snapshot\'s routing read refuses through resolution and neither reads live nor falls back', async () => {
    const { view, calls } = failing('listSourceRoutingRows', refusal);
    const error = await withRequestConfigSnapshot(view, () => resolveRegisteredLocalPathSource(view, '/vaults/x')).then(() => null, (e: unknown) => e);
    expect((error as { code?: string } | null)?.code).toBe('engine_capability_missing');
    expect(calls).not.toContain('listLocalPathSources');
    expect(calls).not.toContain('listSourceRecords');
  });

  test('the live routing read behind the sole-source tier refuses and does not fall back to the legacy rows', async () => {
    await seed('default', null, false);
    await seed('shelf', '/vaults/shelf', false);
    const { view, calls } = failing('listSourceRoutingRows', refusal);
    const error = await resolveSourceWithTier(view, null, '/nowhere/in/particular').then(() => null, (e: unknown) => e);
    expect((error as { code?: string } | null)?.code).toBe('engine_capability_missing');
    expect(calls).not.toContain('listSourceRecords');
  });

  test('the active-config read behind an explicit binding refuses and does not fall back to the legacy rows', async () => {
    await seed('shelf', '/vaults/shelf', false);
    const { view, calls } = failing('listActiveSourceConfigs', refusal);
    const error = await explicitReadBinding(view, 'shelf', 'env').then(() => null, (e: unknown) => e);
    expect((error as { code?: string } | null)?.code).toBe('engine_capability_missing');
    expect(calls).not.toContain('listSourceRecords');
  });
});
