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
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-profile-memory-sqlite-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-profile-memory-pglite-'));
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

async function seedProfileMemory(engine: BrainEngine, id: string, scopeId: string) {
  return engine.upsertProfileMemoryEntry({
    id,
    scope_id: scopeId,
    profile_type: 'routine',
    subject: 'daily routine',
    content: 'Wake at 7 AM, review priorities, then write.',
    source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
    sensitivity: 'personal',
    export_status: 'private_only',
    last_confirmed_at: new Date('2026-04-22T00:05:00.000Z'),
    superseded_by: null,
  });
}

async function expectProfileMemory(engine: BrainEngine, id: string, scopeId: string) {
  const entry = await engine.getProfileMemoryEntry(id);
  const entries = await engine.listProfileMemoryEntries({
    scope_id: scopeId,
    limit: 10,
  });

  expect(entry).not.toBeNull();
  expect(entry?.scope_id).toBe(scopeId);
  expect(entry?.profile_type).toBe('routine');
  expect(entry?.subject).toBe('daily routine');
  expect(entry?.sensitivity).toBe('personal');
  expect(entry?.export_status).toBe('private_only');
  expect(entry?.source_refs).toEqual(['User, direct message, 2026-04-22 9:05 AM KST']);
  expect(entries.map((candidate) => candidate.id)).toContain(id);
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} persists profile memory entries across reopen`, async () => {
    const harness = await createHarness();
    const scopeId = 'personal:default';
    const id = `profile-memory:${scopeId}:${harness.label}`;
    let reopened: BrainEngine | null = null;

    try {
      await seedProfileMemory(harness.engine, id, scopeId);
      await expectProfileMemory(harness.engine, id, scopeId);

      await harness.engine.disconnect();
      reopened = await harness.reopen();
      await expectProfileMemory(reopened, id, scopeId);

      const filtered = await reopened.listProfileMemoryEntries({
        scope_id: scopeId,
        subject: 'daily routine',
        limit: 1,
        offset: 0,
      });
      expect(filtered.map((candidate) => candidate.id)).toEqual([id]);

      await reopened.deleteProfileMemoryEntry(id);
      expect(await reopened.getProfileMemoryEntry(id)).toBeNull();
    } finally {
      await reopened?.disconnect();
      await harness.cleanup();
    }
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  test('postgres persists profile memory entries', async () => {
    const scopeId = 'personal:default';
    const id = `profile-memory:${scopeId}:postgres:${Date.now()}`;
    const engine = new PostgresEngine();
    const reopened = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await seedProfileMemory(engine, id, scopeId);
      await expectProfileMemory(engine, id, scopeId);

      await engine.disconnect();
      await reopened.connect({ engine: 'postgres', database_url: databaseUrl });
      await reopened.initSchema();
      await expectProfileMemory(reopened, id, scopeId);
    } finally {
      const cleanupEngine = reopened as PostgresEngine;
      if (!(cleanupEngine as any)._sql) {
        await cleanupEngine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      await cleanupEngine.deleteProfileMemoryEntry(id).catch(() => undefined);
      await reopened.disconnect();
      await engine.disconnect().catch(() => undefined);
    }
  });
} else {
  test.skip('postgres profile memory persistence skipped: DATABASE_URL is not configured', () => {});
}
