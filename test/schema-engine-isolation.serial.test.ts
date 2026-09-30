import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { performSync } from '../src/commands/sync.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { loadActivePackBestEffort, loadActivePackForLocalEngine } from '../src/core/schema-pack/best-effort.ts';
import { loadActivePackForWriteVocabulary, packDeclaresPageType } from '../src/core/schema-pack/write-vocabulary.ts';
import { loadActivePackForOp } from '../src/core/schema-pack/op-trust-gate.ts';
import { approvedSchemaIdentity, checkApprovedSchemaForEngine, loadActivePackForEngine } from '../src/core/schema-pack/engine-resolution.ts';
import { loadResolvedPackByName } from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { expandEngineTypeFilters } from '../src/core/schema-pack/query-types.ts';
import { hybridSearch, hybridSearchCached } from '../src/core/search/hybrid.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { findExperts } from '../src/commands/whoknows.ts';
import { withEnv } from './helpers/with-env.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

const home = mkdtempSync(join(tmpdir(), 'schema-engine-isolation-'));
const configDir = join(home, '.gbrain');
let engine: PGLiteEngine;
let host: PGLiteEngine;
const configBytes = JSON.stringify({ engine: 'pglite', schema_pack: 'host-pack', ai: { default_model: 'host-model' } });

function writePack(name: string, type: string, parent = 'gbrain-base') {
  const dir = join(configDir, 'schema-packs', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    api_version: 'gbrain-schema-pack-v1', name, version: '1.0.0', extends: parent,
    page_types: [{ name: type, primitive: 'entity', path_prefixes: ['initiatives/'], aliases: ['company'] }],
  }));
}

function ctx(target = engine): OperationContext {
  return { engine: target, remote: false, sourceId: 'default', config: { engine: 'pglite', schema_pack: 'host-pack' }, dryRun: false,
    logger: { info() {}, warn() {}, error() {}, debug() {} } } as OperationContext;
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(id: string, managed = false) {
  const root = join(home, id);
  mkdirSync(join(root, 'initiatives'), { recursive: true });
  const bytes = '---\ntitle: Example initiative\n---\nQuasar initiative ownership belongs to the example team.\n';
  writeFileSync(join(root, 'initiatives', 'example.md'), bytes);
  await makeGitFixture(root);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Synthetic schema isolation fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  if (managed) {
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
  return { root, bytes };
}

beforeAll(async () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), configBytes);
  writePack('host-pack', 'host-initiative');
  writePack('target-pack', 'initiative');
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  host = new PGLiteEngine();
  await host.connect({});
  await host.initSchema();
  await engine.setConfig('schema_pack', 'target-pack');
  await host.setConfig('schema_pack', 'host-pack');
}, 120_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    await host.disconnect();
  });
  _resetPackCacheForTests();
  rmSync(home, { recursive: true, force: true });
});

test('all engine-backed loaders use the selected brain without changing host config', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  expect((await loadActivePackForEngine(engine, { remote: false })).manifest.name).toBe('target-pack');
  expect((await loadActivePackBestEffort(ctx()))?.manifest.name).toBe('target-pack');
  expect((await loadActivePackForLocalEngine(engine))?.manifest.name).toBe('target-pack');
  expect((await loadActivePackForOp(ctx(), {})).manifest.name).toBe('target-pack');
  const vocabulary = await loadActivePackForWriteVocabulary(ctx());
  expect(vocabulary?.manifest.name).toBe('target-pack');
  expect(packDeclaresPageType(vocabulary!, 'initiative')).toBe(true);
  expect(packDeclaresPageType(vocabulary!, 'host-initiative')).toBe(false);
  expect((await loadActivePackForLocalEngine(host))?.manifest.name).toBe('host-pack');
  expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(configBytes);
}));

test('absent brain and source keys still permit ordinary file fallback', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  const absent = { getConfig: async () => null };
  expect((await loadActivePackForEngine(absent, { remote: false, sourceId: 'default' })).manifest.name).toBe('host-pack');
  expect((await expandEngineTypeFilters(absent, { types: ['company'], sourceId: 'default' })).types).toEqual(['company', 'host-initiative']);
  const noSourceOverride = { getConfig: async (key: string) => key === 'schema_pack' ? 'target-pack' : null };
  expect((await loadActivePackForEngine(noSourceOverride, { remote: false, sourceId: 'default' })).manifest.name).toBe('target-pack');
}));

for (const failedKey of ['schema_pack', 'schema_pack.source.default']) {
  test(`failed ${failedKey} lookup never uses host vocabulary in typed reads`, async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
    const failure = new Error(`Cannot read ${failedKey}`);
    const originalGetConfig = engine.getConfig.bind(engine);
    const configRead = spyOn(engine, 'getConfig').mockImplementation(async key => {
      if (key === failedKey) throw failure;
      if (key === 'search.mcp_keyword_only') return 'true';
      return originalGetConfig(key);
    });
    const keywordRead = spyOn(engine, 'searchKeyword');
    const vectorRead = spyOn(engine, 'searchVector');
    const opts = { sourceId: 'default', types: ['company'], expansion: false, useCache: false };
    try {
      await expect(loadActivePackForEngine(engine, { remote: false, sourceId: 'default' })).rejects.toBe(failure);
      await expect(loadActivePackForOp(ctx(), {})).rejects.toBe(failure);
      expect(await loadActivePackBestEffort(ctx())).toBeNull();
      expect(await loadActivePackForLocalEngine(engine, { sourceId: 'default' })).toBeNull();
      expect(await loadActivePackForWriteVocabulary(ctx())).toBeNull();
      await expect(expandEngineTypeFilters(engine, opts)).rejects.toBe(failure);
      await expect(hybridSearch(engine, 'quasar', opts)).rejects.toBe(failure);
      await expect(hybridSearchCached(engine, 'quasar', opts)).rejects.toBe(failure);
      await expect(operations.find(op => op.name === 'search')!.handler(ctx(), { query: 'quasar', source_id: 'default', types: ['company'] })).rejects.toBe(failure);
      await expect(operations.find(op => op.name === 'query')!.handler(ctx(), { query: 'quasar', source_id: 'default', types: ['company'], expand: false })).rejects.toBe(failure);
      await expect(operations.find(op => op.name === 'query')!.handler(ctx(), { image: 'c3ludGhldGlj', image_mime: 'image/png', source_id: 'default', types: ['company'] })).rejects.toBe(failure);
      expect(keywordRead).not.toHaveBeenCalled();
      expect(vectorRead).not.toHaveBeenCalled();
    } finally {
      vectorRead.mockRestore();
      keywordRead.mockRestore();
      configRead.mockRestore();
    }
  }));
}

test('explicit empty type sets deny hybrid and expert reads before any engine or cache access', async () => {
  const access = new Proxy({} as PGLiteEngine, { get() { throw new Error('Empty filters must not access the engine'); } });
  for (const type of [undefined, 'company']) {
    expect(await expandEngineTypeFilters(access, { type, types: [] })).toEqual({ type: undefined, types: [] });
    expect(await hybridSearch(access, 'quasar', { type, types: [] })).toEqual([]);
    expect(await hybridSearchCached(access, 'quasar', { type, types: [], useCache: true })).toEqual([]);
  }
  expect(await findExperts(access, { topic: 'quasar', types: [] })).toEqual([]);
  expect(await expandEngineTypeFilters(access, {})).toEqual({});
  for (const name of ['search', 'query']) {
    await expect(operations.find(op => op.name === name)!.handler(ctx(access), { query: 'quasar', types: [] })).rejects.toThrow('no usable page-type strings');
  }
});

test('general CLI/env precedence remains intact while strict approval rejects conflicts', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: 'host-pack' }, async () => {
  const approved = approvedSchemaIdentity(await loadResolvedPackByName('target-pack'));
  expect((await loadActivePackForEngine(engine, { remote: false })).manifest.name).toBe('host-pack');
  expect((await loadActivePackForEngine(engine, { remote: false, perCall: 'target-pack' })).manifest.name).toBe('target-pack');
  await expect(checkApprovedSchemaForEngine(engine, approved, { remote: false, perCall: 'target-pack', allowBinding: true })).rejects.toThrow('override');
  await expect(loadActivePackForOp({ ...ctx(), remote: true }, { schema_pack: 'target-pack' })).rejects.toThrow('remote/MCP');
  expect(await engine.getConfig('schema_pack')).toBe('target-pack');
  expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(configBytes);
}));

test('strict approval proposes only a selected-DB binding and fails closed on unreadable config', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  const approved = approvedSchemaIdentity(await loadResolvedPackByName('target-pack'));
  expect((await checkApprovedSchemaForEngine(engine, approved, { remote: false })).binding).toBeNull();
  await expect(checkApprovedSchemaForEngine(host, approved, { remote: false })).rejects.toThrow('not bound');
  expect((await checkApprovedSchemaForEngine(host, approved, { remote: false, allowBinding: true })).binding)
    .toEqual({ key: 'schema_pack', value: 'target-pack', expectedValue: 'host-pack' });
  await expect(checkApprovedSchemaForEngine(engine, approved, { remote: true, allowBinding: true })).rejects.toThrow('trusted local');
  await expect(checkApprovedSchemaForEngine({ getConfig: async () => { throw new Error('offline'); }, executeRaw: engine.executeRaw.bind(engine) }, approved, { remote: false, allowBinding: true })).rejects.toThrow('offline');
  expect(await host.getConfig('schema_pack')).toBe('host-pack');
  expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(configBytes);
}));

test('per-source overrides are read from the selected DB and mixed-schema reads refuse', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  await engine.setConfig('schema_pack.source.other', 'host-pack');
  try {
    expect((await loadActivePackForEngine(engine, { remote: false, sourceId: 'other' })).manifest.name).toBe('host-pack');
    await expect(expandEngineTypeFilters(engine, { types: ['company'], sourceIds: ['default', 'other'] })).rejects.toThrow('different schema packs');
    const refusal = await expandEngineTypeFilters(engine, { types: ['company'], sourceIds: ['default', 'other'] }).catch(error => error);
    expect(refusal).toBeInstanceOf(OperationError);
    expect(refusal.toJSON().error).toBe('permission_denied');
    const approved = approvedSchemaIdentity(await loadResolvedPackByName('target-pack'));
    await expect(checkApprovedSchemaForEngine(engine, approved, { remote: false, allowBinding: true })).rejects.toThrow('override');
    await expect(loadActivePackForOp({ ...ctx(), auth: { allowedSources: ['default', 'other'] } } as OperationContext, {})).rejects.toThrow('distinct packs');
  } finally {
    await engine.executeRaw("DELETE FROM config WHERE key='schema_pack.source.other'");
  }
}));

test('strict approval detects parent changes within the registry TTL without child or alias changes', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  writePack('parent-pack', 'parent-initiative');
  writePack('child-pack', 'child-initiative', 'parent-pack');
  const before = await loadResolvedPackByName('child-pack');
  const approved = approvedSchemaIdentity(before);
  const path = join(configDir, 'schema-packs', 'parent-pack', 'pack.json');
  const parent = JSON.parse(readFileSync(path, 'utf8'));
  parent.frontmatter_links = [{ page_type: 'parent-initiative', fields: ['owner'], link_type: 'owns' }];
  writeFileSync(path, JSON.stringify(parent));
  await expect(checkApprovedSchemaForEngine(engine, approved, { remote: false, allowBinding: true })).rejects.toThrow('inherited definitions changed');
  const after = await loadResolvedPackByName('child-pack');
  expect(after.identity).toBe(before.identity);
  expect(after.alias_closure_hash).toBe(before.alias_closure_hash);
  expect(approvedSchemaIdentity(after).resolvedManifestHash).not.toBe(approved.resolvedManifestHash);
}));

test('CLI import honors target schema after resolving the source flag', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  const { root } = await fixture('import-example');
  const result = await runImport(engine, [root, '--no-embed', '--json', '--source', 'import-example']);
  expect(result.imported).toBe(1);
  expect((await engine.getPage('initiatives/example', { sourceId: 'import-example' }))?.type).toBe('initiative');
  expect(await host.getPage('initiatives/example', { sourceId: 'default' })).toBeNull();
}), 120_000);

test('CLI-selected source schema is resolved after argument precedence', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  const { root } = await fixture('source-override-example');
  await engine.setConfig('schema_pack.source.source-override-example', 'host-pack');
  try {
    await runImport(engine, [root, '--no-embed', '--json', '--source', 'source-override-example'], { sourceId: 'default' });
    expect((await engine.getPage('initiatives/example', { sourceId: 'source-override-example' }))?.type).toBe('host-initiative');
  } finally {
    await engine.executeRaw("DELETE FROM config WHERE key='schema_pack.source.source-override-example'");
  }
}), 120_000);

test('first and incremental legacy sync use the target schema', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  const { root } = await fixture('sync-example');
  const options = { sourceId: 'sync-example', repoPath: root, noPull: true, noEmbed: true, noExtract: true };
  await performSync(engine, options);
  expect((await engine.getPage('initiatives/example', { sourceId: 'sync-example' }))?.type).toBe('initiative');
  writeFileSync(join(root, 'initiatives', 'second.md'), '---\ntitle: Second example\n---\nDistinct quasar ownership tracking for another initiative.\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Another synthetic initiative');
  await performSync(engine, options);
  expect((await engine.getPage('initiatives/second', { sourceId: 'sync-example' }))?.type).toBe('initiative');
}), 120_000);

test('typed query closure uses the target pack in keyword and hybrid reads', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  expect((await expandEngineTypeFilters(engine, { type: 'company' })).types).toEqual(['company', 'initiative']);
  expect((await expandEngineTypeFilters(host, { type: 'company' })).types).toEqual(['company', 'host-initiative']);
  const opts = { sourceId: 'import-example', types: ['company'], expansion: false, useCache: false, vector: false, limit: 10 };
  expect((await hybridSearch(engine, 'quasar', opts)).some(row => row.type === 'initiative')).toBe(true);
  expect((await hybridSearchCached(engine, 'quasar', { ...opts, type: 'company', types: undefined })).some(row => row.type === 'initiative')).toBe(true);
  await engine.setConfig('search.mcp_keyword_only', 'true');
  const results = await operations.find(op => op.name === 'search')!.handler(ctx(), { query: 'quasar', source_id: 'import-example', types: ['company'] });
  expect((results as Array<{ type: string }>).some(row => row.type === 'initiative')).toBe(true);
  expect((await expandEngineTypeFilters(engine, { type: 'company', types: ['note'] })).types).toEqual([]);
  expect(await hybridSearch(engine, 'quasar', { ...opts, type: 'note' })).toEqual([]);
  await withEnv({ GBRAIN_SCHEMA_PACK: 'missing-pack' }, async () => {
    expect(await hybridSearch(engine, 'quasar', opts)).toEqual([]);
    expect(await operations.find(op => op.name === 'search')!.handler(ctx(), { query: 'quasar', types: ['company'] })).toEqual([]);
  });
}), 120_000);

test('managed prepared import retains target types and leaves committed source bytes unchanged', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
  const { root, bytes } = await fixture('managed-example', true);
  try {
    const result = await performManagedSync(engine, { sourceId: 'managed-example', noPull: true });
    expect(result).toMatchObject({ status: 'first_sync', filesImported: 1 });
    expect((await engine.getPage('initiatives/example', { sourceId: 'managed-example' }))?.type).toBe('initiative');
    expect(readFileSync(join(root, 'initiatives', 'example.md'), 'utf8')).toBe(bytes);
    expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(configBytes);
    expect(await host.getConfig('schema_pack')).toBe('host-pack');
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }
}), 120_000);
