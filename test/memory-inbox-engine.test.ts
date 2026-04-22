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
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-sqlite-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-pglite-'));
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

async function seedMemoryCandidate(engine: BrainEngine, id: string, scopeId: string) {
  return engine.createMemoryCandidateEntry({
    id,
    scope_id: scopeId,
    candidate_type: 'fact',
    proposed_content: 'Context maps can propose a note update candidate.',
    source_refs: ['User, direct message, 2026-04-22 3:01 PM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.95,
    importance_score: 0.8,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/note-manifest',
    reviewed_at: null,
    review_reason: null,
  });
}

async function expectMemoryCandidate(engine: BrainEngine, id: string, scopeId: string) {
  const entry = await engine.getMemoryCandidateEntry(id);
  const entries = await engine.listMemoryCandidateEntries({
    scope_id: scopeId,
    limit: 10,
  });

  expect(entry).not.toBeNull();
  expect(entry?.scope_id).toBe(scopeId);
  expect(entry?.candidate_type).toBe('fact');
  expect(entry?.generated_by).toBe('manual');
  expect(entry?.extraction_kind).toBe('manual');
  expect(entry?.sensitivity).toBe('work');
  expect(entry?.status).toBe('captured');
  expect(entry?.source_refs).toEqual(['User, direct message, 2026-04-22 3:01 PM KST']);
  expect(entries.map((candidate) => candidate.id)).toContain(id);
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} persists memory candidate entries across reopen`, async () => {
    const harness = await createHarness();
    const scopeId = 'workspace:default';
    const id = `memory-candidate:${scopeId}:${harness.label}`;
    let reopened: BrainEngine | null = null;

    try {
      await seedMemoryCandidate(harness.engine, id, scopeId);
      await expectMemoryCandidate(harness.engine, id, scopeId);

      await harness.engine.disconnect();
      reopened = await harness.reopen();
      await expectMemoryCandidate(reopened, id, scopeId);

      const filtered = await reopened.listMemoryCandidateEntries({
        scope_id: scopeId,
        status: 'captured',
        candidate_type: 'fact',
        limit: 1,
        offset: 0,
      });
      expect(filtered.map((candidate) => candidate.id)).toEqual([id]);

      const advanced = await reopened.updateMemoryCandidateEntryStatus(id, {
        status: 'candidate',
        reviewed_at: new Date('2026-04-22T06:00:00.000Z'),
        review_reason: 'Prepared for review queue.',
      });
      expect(advanced.status).toBe('candidate');
      expect(advanced.review_reason).toBe('Prepared for review queue.');

      await reopened.deleteMemoryCandidateEntry(id);
      expect(await reopened.getMemoryCandidateEntry(id)).toBeNull();
    } finally {
      await reopened?.disconnect();
      await harness.cleanup();
    }
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  test('postgres persists memory candidate entries', async () => {
    const scopeId = 'workspace:default';
    const id = `memory-candidate:${scopeId}:postgres:${Date.now()}`;
    const engine = new PostgresEngine();
    const reopened = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await seedMemoryCandidate(engine, id, scopeId);
      await expectMemoryCandidate(engine, id, scopeId);

      await engine.disconnect();
      await reopened.connect({ engine: 'postgres', database_url: databaseUrl });
      await reopened.initSchema();
      await expectMemoryCandidate(reopened, id, scopeId);
    } finally {
      const cleanupEngine = reopened as PostgresEngine;
      if (!(cleanupEngine as any)._sql) {
        await cleanupEngine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      await cleanupEngine.deleteMemoryCandidateEntry(id).catch(() => undefined);
      await reopened.disconnect();
      await engine.disconnect().catch(() => undefined);
    }
  });
} else {
  test.skip('postgres memory inbox persistence skipped: DATABASE_URL is not configured', () => {});
}
