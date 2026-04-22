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
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-episode-sqlite-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-episode-pglite-'));
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

async function seedPersonalEpisode(engine: BrainEngine, id: string, scopeId: string) {
  return engine.createPersonalEpisodeEntry({
    id,
    scope_id: scopeId,
    title: 'Morning reset',
    start_time: new Date('2026-04-22T06:30:00.000Z'),
    end_time: new Date('2026-04-22T07:00:00.000Z'),
    source_kind: 'chat',
    summary: 'Re-established the daily routine after travel.',
    source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
    candidate_ids: ['profile-1'],
  } as any);
}

async function expectPersonalEpisode(engine: BrainEngine, id: string, scopeId: string) {
  const entry = await engine.getPersonalEpisodeEntry(id);
  const entries = await engine.listPersonalEpisodeEntries({
    scope_id: scopeId,
    limit: 10,
  });

  expect(entry).not.toBeNull();
  expect(entry?.scope_id).toBe(scopeId);
  expect(entry?.title).toBe('Morning reset');
  expect(entry?.source_kind).toBe('chat');
  expect(entry?.candidate_ids).toEqual(['profile-1']);
  expect(entries.map((candidate) => candidate.id)).toContain(id);
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} persists personal episode entries across reopen`, async () => {
    const harness = await createHarness();
    const scopeId = 'personal:default';
    const id = `personal-episode:${scopeId}:${harness.label}`;
    let reopened: BrainEngine | null = null;

    try {
      await seedPersonalEpisode(harness.engine, id, scopeId);
      await expectPersonalEpisode(harness.engine, id, scopeId);

      await harness.engine.disconnect();
      reopened = await harness.reopen();
      await expectPersonalEpisode(reopened, id, scopeId);

      const filtered = await reopened.listPersonalEpisodeEntries({
        scope_id: scopeId,
        title: 'Morning reset',
        limit: 1,
        offset: 0,
      } as any);
      expect(filtered.map((candidate) => candidate.id)).toEqual([id]);

      await reopened.deletePersonalEpisodeEntry(id);
      expect(await reopened.getPersonalEpisodeEntry(id)).toBeNull();
    } finally {
      await reopened?.disconnect();
      await harness.cleanup();
    }
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  test('postgres persists personal episode entries', async () => {
    const scopeId = 'personal:default';
    const id = `personal-episode:${scopeId}:postgres:${Date.now()}`;
    const engine = new PostgresEngine();
    const reopened = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await seedPersonalEpisode(engine, id, scopeId);
      await expectPersonalEpisode(engine, id, scopeId);

      await engine.disconnect();
      await reopened.connect({ engine: 'postgres', database_url: databaseUrl });
      await reopened.initSchema();
      await expectPersonalEpisode(reopened, id, scopeId);
    } finally {
      const cleanupEngine = reopened as PostgresEngine;
      if (!(cleanupEngine as any)._sql) {
        await cleanupEngine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      await cleanupEngine.deletePersonalEpisodeEntry(id).catch(() => undefined);
      await reopened.disconnect();
      await engine.disconnect().catch(() => undefined);
    }
  });
} else {
  test.skip('postgres personal episode persistence skipped: DATABASE_URL is not configured', () => {});
}
