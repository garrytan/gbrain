import { setDefaultTimeout, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

interface EngineHarness {
  label: string;
  engine: BrainEngine;
  cleanup: () => Promise<void>;
}

async function createSqliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-historical-validity-sqlite-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  return {
    label: 'sqlite',
    engine,
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-historical-validity-pglite-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();

  return {
    label: 'pglite',
    engine,
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} filters target-bound peer candidates by target_object_id`, async () => {
    const harness = await createHarness();
    const scopeId = `workspace:${harness.label}`;

    try {
      await seedCandidate(harness.engine, `${harness.label}:alpha-1`, scopeId, 'concepts/historical-validity/alpha');
      await seedCandidate(harness.engine, `${harness.label}:alpha-2`, scopeId, 'concepts/historical-validity/alpha');
      await seedCandidate(harness.engine, `${harness.label}:beta`, scopeId, 'concepts/historical-validity/beta');
      await seedCandidate(harness.engine, `${harness.label}:other-scope`, `${scopeId}:other`, 'concepts/historical-validity/alpha');

      const peers = await harness.engine.listMemoryCandidateEntries({
        scope_id: scopeId,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/historical-validity/alpha',
        limit: 10,
        offset: 0,
      });

      expect(peers).toHaveLength(2);
      expect(peers.map((entry) => entry.id).sort()).toEqual([
        `${harness.label}:alpha-1`,
        `${harness.label}:alpha-2`,
      ]);
    } finally {
      await harness.cleanup();
    }
  });
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl) {
  test('postgres filters target-bound peer candidates by target_object_id', async () => {
    const engine = new PostgresEngine();
    const scopeId = `workspace:postgres:${crypto.randomUUID()}`;
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await engine.connect({ engine: 'postgres', database_url: databaseUrl });
    await engine.initSchema();

    try {
      await seedCandidate(engine, ids[0], scopeId, 'concepts/historical-validity/alpha');
      await seedCandidate(engine, ids[1], scopeId, 'concepts/historical-validity/alpha');
      await seedCandidate(engine, ids[2], scopeId, 'concepts/historical-validity/beta');

      const peers = await engine.listMemoryCandidateEntries({
        scope_id: scopeId,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/historical-validity/alpha',
        limit: 10,
        offset: 0,
      });

      expect(peers).toHaveLength(2);
      expect(peers.map((entry) => entry.id).sort()).toEqual([ids[0], ids[1]].sort());
    } finally {
      await engine.sql`DELETE FROM memory_candidate_entries WHERE scope_id = ${scopeId}`;
      await engine.disconnect();
    }
  });
} else {
  test.skip('postgres historical validity filter parity skipped: DATABASE_URL is not configured', () => {});
}

async function seedCandidate(
  engine: BrainEngine,
  id: string,
  scopeId: string,
  targetObjectId: string,
) {
  await engine.createMemoryCandidateEntry({
    id,
    scope_id: scopeId,
    candidate_type: 'fact',
    proposed_content: `Historical validity filter candidate ${id}.`,
    source_refs: ['User, direct message, 2026-04-24 9:10 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.6,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'candidate',
    target_object_type: 'curated_note',
    target_object_id: targetObjectId,
    reviewed_at: null,
    review_reason: null,
  });
}
