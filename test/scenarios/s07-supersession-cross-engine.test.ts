/**
 * Scenario S7 — Supersession invariant holds identically across engines.
 *
 * Falsifies I7 (backend parity: SQLite, Postgres, and local execution paths
 * must preserve the same semantic behavior at the system boundary) and
 * L5 (explicit supersede, not silent deletion).
 *
 * The supersession invariant: updating a candidate's status to 'superseded'
 * without first recording a supersession link must fail, even for callers
 * that bypass the service layer and issue a raw status UPDATE. This is
 * enforced via a plpgsql trigger on Postgres/PGLite and via hand-coded
 * trigger logic on SQLite. Both paths must reject the same way.
 */

import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { supersedeMemoryCandidateEntry } from '../../src/core/services/memory-inbox-supersession-service.ts';
import { seedMemoryCandidate } from './helpers.ts';
import { promoteMemoryCandidateEntry } from '../../src/core/services/memory-inbox-promotion-service.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

type ScenarioEngine = SQLiteEngine | PGLiteEngine | PostgresEngine;

function uniqueScenarioId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedTwoPromotedCandidates(
  engine: ScenarioEngine,
  prefix: string,
): Promise<{ oldId: string; newId: string }> {
  const oldId = `${prefix}-old`;
  const newId = `${prefix}-new`;
  await seedMemoryCandidate(engine, {
    id: oldId,
    status: 'staged_for_review',
    target_object_id: `concepts/${prefix}`,
  });
  await seedMemoryCandidate(engine, {
    id: newId,
    status: 'staged_for_review',
    target_object_id: `concepts/${prefix}`,
  });
  await promoteMemoryCandidateEntry(engine, { id: oldId });
  await promoteMemoryCandidateEntry(engine, { id: newId });
  return { oldId, newId };
}

async function allocateSqlite(label: string): Promise<{ engine: SQLiteEngine; teardown: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-s07-${label}-`));
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return {
    engine,
    teardown: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function allocatePglite(label: string): Promise<{ engine: PGLiteEngine; teardown: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-s07-${label}-`));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(dir, 'pglite') });
  await engine.initSchema();
  return {
    engine,
    teardown: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const databaseUrl = process.env.DATABASE_URL;

async function allocatePostgres(_label: string): Promise<{ engine: PostgresEngine; teardown: () => Promise<void> }> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured');
  }

  const engine = new PostgresEngine();
  await engine.connect({ engine: 'postgres', database_url: databaseUrl });
  await engine.initSchema();
  return {
    engine,
    teardown: async () => {
      await engine.disconnect();
    },
  };
}

async function expectRawSupersededTransitionToFail(engine: ScenarioEngine, candidateId: string): Promise<void> {
  const invariantPattern = /superseded candidate requires a supersession link record/;

  if (engine instanceof SQLiteEngine) {
    const db = (engine as any).database;
    expect(() => {
      db.query(`
        UPDATE memory_candidate_entries
        SET status = 'superseded'
        WHERE id = ?
      `).run(candidateId);
    }).toThrow(invariantPattern);
    return;
  }

  if (engine instanceof PGLiteEngine) {
    const db = (engine as any).db;
    await expect(db.query(
      `UPDATE memory_candidate_entries
       SET status = 'superseded'
       WHERE id = $1`,
      [candidateId],
    )).rejects.toThrow(invariantPattern);
    return;
  }

  await expect(
    engine.sql`
      UPDATE memory_candidate_entries
      SET status = 'superseded'
      WHERE id = ${candidateId}
    `,
  ).rejects.toThrow(invariantPattern);
}

// PGLite cold-starts are ~2-4s (instantiation + 19 migrations). Under full
// suite load these can exceed the default 5s test timeout. Per-test timeout
// override is the pattern PR #36 applied to phase8 bench tests.
const ENGINE_COLD_START_BUDGET_MS = 30_000;

function runEngineSuite(
  label: 'sqlite' | 'pglite' | 'postgres',
  allocate: (label: string) => Promise<{ engine: ScenarioEngine; teardown: () => Promise<void> }>,
) {
  describe(`S7 [${label}] — supersession invariant`, () => {
    test('recording a supersession link succeeds and flips old status to superseded', async () => {
      const handle = await allocate(`succ-${label}`);
      try {
        const ids = await seedTwoPromotedCandidates(handle.engine, uniqueScenarioId(`basic-${label}`));

        const result = await supersedeMemoryCandidateEntry(handle.engine, {
          superseded_candidate_id: ids.oldId,
          replacement_candidate_id: ids.newId,
          review_reason: 'Newer claim replaces older one',
        });

        expect(result.supersession_entry).not.toBeNull();
        expect(result.supersession_entry!.superseded_candidate_id).toBe(ids.oldId);
        expect(result.supersession_entry!.replacement_candidate_id).toBe(ids.newId);

        const superseded = await handle.engine.getMemoryCandidateEntry(ids.oldId);
        expect(superseded?.status).toBe('superseded');
      } finally {
        await handle.teardown();
      }
    }, ENGINE_COLD_START_BUDGET_MS);

    test('raw status update to superseded without a supersession link is rejected', async () => {
      const handle = await allocate(`illegal-${label}`);
      const candidateId = uniqueScenarioId(`illegal-${label}`);

      try {
        await seedMemoryCandidate(handle.engine, {
          id: candidateId,
          status: 'staged_for_review',
        });
        await promoteMemoryCandidateEntry(handle.engine, { id: candidateId });

        await expectRawSupersededTransitionToFail(handle.engine, candidateId);

        const stored = await handle.engine.getMemoryCandidateEntry(candidateId);
        expect(stored?.status).toBe('promoted');
      } finally {
        await handle.teardown();
      }
    }, ENGINE_COLD_START_BUDGET_MS);

    test('self-supersession (same id as both sides) is rejected', async () => {
      const handle = await allocate(`self-${label}`);
      const candidateId = uniqueScenarioId(`self-${label}`);
      try {
        await seedMemoryCandidate(handle.engine, {
          id: candidateId,
          status: 'staged_for_review',
        });
        await promoteMemoryCandidateEntry(handle.engine, { id: candidateId });

        await expect(
          supersedeMemoryCandidateEntry(handle.engine, {
            superseded_candidate_id: candidateId,
            replacement_candidate_id: candidateId,
          }),
        ).rejects.toThrow();
      } finally {
        await handle.teardown();
      }
    }, ENGINE_COLD_START_BUDGET_MS);
  });
}

runEngineSuite('sqlite', allocateSqlite);
runEngineSuite('pglite', allocatePglite);
if (databaseUrl) {
  runEngineSuite('postgres', allocatePostgres);
} else {
  describe('S7 [postgres] — supersession invariant', () => {
    test.skip('postgres coverage skipped: DATABASE_URL is not configured', () => {});
  });
}
