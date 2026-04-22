import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

interface EngineHarness {
  label: string;
  engine: BrainEngine;
  reopen: () => Promise<BrainEngine>;
  cleanup: () => Promise<void>;
}

async function createSqliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-sqlite-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  return {
    label: 'sqlite',
    engine,
    reopen: async () => {
      const reopened = new SQLiteEngine();
      await reopened.connect({ engine: 'sqlite', database_path: databasePath });
      await reopened.initSchema();
      return reopened;
    },
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-atlas-pglite-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();

  return {
    label: 'pglite',
    engine,
    reopen: async () => {
      const reopened = new PGLiteEngine();
      await reopened.connect({ engine: 'pglite', database_path: dir });
      await reopened.initSchema();
      return reopened;
    },
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedAtlas(engine: BrainEngine, id: string, mapId: string, scopeId: string) {
  return engine.upsertContextAtlasEntry({
    id,
    map_id: mapId,
    scope_id: scopeId,
    kind: 'workspace',
    title: 'Workspace Atlas',
    freshness: 'fresh',
    entrypoints: ['page:concepts/note-manifest', 'page:systems/mbrain'],
    budget_hint: 6,
  });
}

async function expectAtlas(engine: BrainEngine, id: string, scopeId: string) {
  const entry = await engine.getContextAtlasEntry(id);
  const entries = await engine.listContextAtlasEntries({
    scope_id: scopeId,
    kind: 'workspace',
  });

  expect(entry).not.toBeNull();
  expect(entry?.title).toBe('Workspace Atlas');
  expect(entry?.freshness).toBe('fresh');
  expect(entry?.entrypoints).toEqual(['page:concepts/note-manifest', 'page:systems/mbrain']);
  expect(entry?.budget_hint).toBe(6);
  expect(entries.map((candidate) => candidate.id)).toContain(id);
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} persists context atlas entries across reopen`, async () => {
    const harness = await createHarness();
    const scopeId = 'workspace:default';
    const mapId = `context-map:workspace:${scopeId}:${harness.label}`;
    const id = `context-atlas:workspace:${scopeId}:${harness.label}`;
    let reopened: BrainEngine | null = null;

    try {
      await harness.engine.upsertContextMapEntry({
        id: mapId,
        scope_id: scopeId,
        kind: 'workspace',
        title: 'Workspace Structural Map',
        build_mode: 'structural',
        status: 'ready',
        source_set_hash: 'hash-123',
        extractor_version: 'phase2-context-map-v1',
        node_count: 2,
        edge_count: 1,
        community_count: 0,
        graph_json: { nodes: [], edges: [] },
      });
      await seedAtlas(harness.engine, id, mapId, scopeId);
      await expectAtlas(harness.engine, id, scopeId);

      await harness.engine.disconnect();
      reopened = await harness.reopen();
      await expectAtlas(reopened, id, scopeId);

      await reopened.deleteContextAtlasEntry(id);
      expect(await reopened.getContextAtlasEntry(id)).toBeNull();
    } finally {
      await reopened?.disconnect();
      await harness.cleanup();
    }
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  test('postgres persists context atlas entries', async () => {
    const scopeId = 'workspace:default';
    const mapId = `context-map:workspace:${scopeId}:postgres:${Date.now()}`;
    const id = `context-atlas:workspace:${scopeId}:postgres:${Date.now()}`;
    const engine = new PostgresEngine();
    const reopened = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await engine.upsertContextMapEntry({
        id: mapId,
        scope_id: scopeId,
        kind: 'workspace',
        title: 'Workspace Structural Map',
        build_mode: 'structural',
        status: 'ready',
        source_set_hash: 'hash-123',
        extractor_version: 'phase2-context-map-v1',
        node_count: 2,
        edge_count: 1,
        community_count: 0,
        graph_json: { nodes: [], edges: [] },
      });
      await seedAtlas(engine, id, mapId, scopeId);
      await expectAtlas(engine, id, scopeId);

      await engine.disconnect();
      await reopened.connect({ engine: 'postgres', database_url: databaseUrl });
      await reopened.initSchema();
      await expectAtlas(reopened, id, scopeId);
    } finally {
      const cleanupEngine = reopened as PostgresEngine;
      if (!(cleanupEngine as any)._sql) {
        await cleanupEngine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      await cleanupEngine.deleteContextAtlasEntry(id).catch(() => undefined);
      await cleanupEngine.deleteContextMapEntry(mapId).catch(() => undefined);
      await reopened.disconnect();
      await engine.disconnect().catch(() => undefined);
    }
  });
} else {
  test.skip('postgres context atlas persistence skipped: DATABASE_URL is not configured', () => {});
}
