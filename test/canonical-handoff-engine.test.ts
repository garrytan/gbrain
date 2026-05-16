import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { advanceMemoryCandidateStatus } from '../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../src/core/services/memory-inbox-promotion-service.ts';

interface EngineHarness {
  label: string;
  engine: BrainEngine;
  reopen: () => Promise<BrainEngine>;
  cleanup: () => Promise<void>;
}

const PGLITE_REOPEN_TEST_TIMEOUT_MS = 45_000;

async function createSqliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-handoff-sqlite-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-handoff-pglite-'));
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

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} persists canonical handoff entries across reopen`, async () => {
    const harness = await createHarness();
    const scopeId = `workspace:${harness.label}`;
    const candidateId = `candidate:${harness.label}`;
    const handoffId = `handoff:${harness.label}`;
    const otherScopeId = `${scopeId}:other`;
    let reopened: BrainEngine | null = null;

    try {
      await seedPromotedCandidate(harness.engine, candidateId, scopeId);
      await seedPromotedCandidate(harness.engine, `${candidateId}:other`, otherScopeId);

      const created = await harness.engine.createCanonicalHandoffEntry({
        id: handoffId,
        scope_id: scopeId,
        candidate_id: candidateId,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/canonical-handoff',
        source_refs: ['forged caller provenance'],
        review_reason: 'Recorded for engine persistence.',
      });
      expect(created?.candidate_id).toBe(candidateId);
      expect(created?.source_refs).toEqual(['User, direct message, 2026-04-24 7:00 AM KST']);

      expect(await harness.engine.createCanonicalHandoffEntry({
        id: `${handoffId}:duplicate`,
        scope_id: scopeId,
        candidate_id: candidateId,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/canonical-handoff',
        source_refs: ['User, direct message, 2026-04-24 7:00 AM KST'],
      })).toBeNull();

      const loaded = await harness.engine.getCanonicalHandoffEntry(handoffId);
      expect(loaded?.target_object_type).toBe('curated_note');
      expect(loaded?.source_refs).toEqual(['User, direct message, 2026-04-24 7:00 AM KST']);

      const scoped = await harness.engine.listCanonicalHandoffEntries({
        scope_id: scopeId,
        limit: 10,
        offset: 0,
      });
      expect(scoped.map((entry) => entry.id)).toEqual([handoffId]);

      const blankScoped = await harness.engine.listCanonicalHandoffEntries({
        scope_id: '',
        limit: 10,
        offset: 0,
      });
      expect(blankScoped).toEqual([]);

      await harness.engine.disconnect();
      reopened = await harness.reopen();

      const reopenedLoaded = await reopened.getCanonicalHandoffEntry(handoffId);
      expect(reopenedLoaded?.candidate_id).toBe(candidateId);
      const reopenedScoped = await reopened.listCanonicalHandoffEntries({
        scope_id: scopeId,
        limit: 10,
        offset: 0,
      });
      expect(reopenedScoped.map((entry) => entry.id)).toEqual([handoffId]);
    } finally {
      if (reopened) {
        await reopened.disconnect();
      }
      await harness.cleanup();
    }
  }, createHarness === createPgliteHarness ? PGLITE_REOPEN_TEST_TIMEOUT_MS : undefined);
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl) {
  test('postgres persists canonical handoff entries', async () => {
    const engine = new PostgresEngine();
    const scopeId = `workspace:postgres:${crypto.randomUUID()}`;
    const candidateId = `candidate:${crypto.randomUUID()}`;
    const handoffId = `handoff:${crypto.randomUUID()}`;
    await engine.connect({ engine: 'postgres', database_url: databaseUrl });
    await engine.initSchema();

    try {
      await seedPromotedCandidate(engine, candidateId, scopeId);

      const candidateSourceRefs = await engine.sql`
        SELECT jsonb_typeof(source_refs) AS kind
        FROM memory_candidate_entries
        WHERE id = ${candidateId}
      `;
      expect(candidateSourceRefs[0]?.kind).toBe('array');

      const created = await engine.createCanonicalHandoffEntry({
        id: handoffId,
        scope_id: scopeId,
        candidate_id: candidateId,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/canonical-handoff',
        source_refs: ['forged caller provenance'],
        review_reason: 'Recorded for postgres persistence.',
      });
      expect(created?.id).toBe(handoffId);
      expect(created?.source_refs).toEqual(['User, direct message, 2026-04-24 7:00 AM KST']);

      const listed = await engine.listCanonicalHandoffEntries({
        scope_id: scopeId,
        limit: 10,
        offset: 0,
      });
      expect(listed.map((entry) => entry.id)).toEqual([handoffId]);
    } finally {
      await engine.sql`DELETE FROM canonical_handoff_entries WHERE id = ${handoffId}`;
      await engine.sql`DELETE FROM memory_candidate_entries WHERE id = ${candidateId}`;
      await engine.disconnect();
    }
  });
} else {
  test.skip('postgres canonical handoff persistence skipped: DATABASE_URL is not configured', () => {});
}

async function seedPromotedCandidate(engine: BrainEngine, id: string, scopeId: string) {
  await engine.createMemoryCandidateEntry({
    id,
    scope_id: scopeId,
    candidate_type: 'fact',
    proposed_content: `Canonical handoff engine candidate ${id}.`,
    source_refs: ['User, direct message, 2026-04-24 7:00 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.9,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/canonical-handoff',
    reviewed_at: null,
    review_reason: null,
  });
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, {
    id,
    next_status: 'staged_for_review',
    review_reason: 'Prepared for handoff persistence.',
  });
  await promoteMemoryCandidateEntry(engine, {
    id,
    review_reason: 'Promoted before persistence check.',
  });
}
