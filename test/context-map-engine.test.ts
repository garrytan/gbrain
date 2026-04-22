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
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-sqlite-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-map-pglite-'));
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

async function seedContextMap(engine: BrainEngine, id: string, scopeId: string) {
  return engine.upsertContextMapEntry({
    id,
    scope_id: scopeId,
    kind: 'workspace',
    title: 'Workspace Structural Map',
    build_mode: 'structural',
    status: 'ready',
    source_set_hash: 'hash-123',
    extractor_version: 'phase2-context-map-v1',
    node_count: 3,
    edge_count: 2,
    community_count: 0,
    graph_json: {
      scope_id: scopeId,
      nodes: [
        { node_id: 'page:systems/mbrain', node_kind: 'page' },
        { node_id: 'section:systems/mbrain#overview', node_kind: 'section' },
      ],
      edges: [
        {
          edge_kind: 'page_contains_section',
          from_node_id: 'page:systems/mbrain',
          to_node_id: 'section:systems/mbrain#overview',
        },
      ],
    },
  });
}

async function expectContextMap(engine: BrainEngine, id: string, scopeId: string) {
  const entry = await engine.getContextMapEntry(id);
  const entries = await engine.listContextMapEntries({
    scope_id: scopeId,
    kind: 'workspace',
  });

  expect(entry).not.toBeNull();
  expect(entry?.title).toBe('Workspace Structural Map');
  expect(entry?.build_mode).toBe('structural');
  expect(entry?.status).toBe('ready');
  expect(entry?.source_set_hash).toBe('hash-123');
  expect(entry?.node_count).toBe(3);
  expect(entry?.edge_count).toBe(2);
  expect((entry?.graph_json as any).nodes).toHaveLength(2);
  expect(entries.map((candidate) => candidate.id)).toContain(id);
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} persists context map entries across reopen`, async () => {
    const harness = await createHarness();
    const scopeId = 'workspace:default';
    const id = `context-map:workspace:${scopeId}:${harness.label}`;
    let reopened: BrainEngine | null = null;

    try {
      await seedContextMap(harness.engine, id, scopeId);
      await expectContextMap(harness.engine, id, scopeId);

      await harness.engine.disconnect();
      reopened = await harness.reopen();
      await expectContextMap(reopened, id, scopeId);

      await reopened.deleteContextMapEntry(id);
      expect(await reopened.getContextMapEntry(id)).toBeNull();
    } finally {
      await reopened?.disconnect();
      await harness.cleanup();
    }
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  test('postgres persists context map entries', async () => {
    const scopeId = 'workspace:default';
    const id = `context-map:workspace:${scopeId}:postgres:${Date.now()}`;
    const engine = new PostgresEngine();
    const reopened = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await seedContextMap(engine, id, scopeId);
      await expectContextMap(engine, id, scopeId);

      await engine.disconnect();
      await reopened.connect({ engine: 'postgres', database_url: databaseUrl });
      await reopened.initSchema();
      await expectContextMap(reopened, id, scopeId);
    } finally {
      const cleanupEngine = reopened as PostgresEngine;
      if (!(cleanupEngine as any)._sql) {
        await cleanupEngine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      await cleanupEngine.deleteContextMapEntry(id).catch(() => undefined);
      await reopened.disconnect();
      await engine.disconnect().catch(() => undefined);
    }
  });
} else {
  test.skip('postgres context map persistence skipped: DATABASE_URL is not configured', () => {});
}
