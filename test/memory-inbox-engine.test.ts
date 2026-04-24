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

const ENGINE_COLD_START_BUDGET_MS = 30_000;

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
  const timeoutMs = createHarness === createPgliteHarness
    ? ENGINE_COLD_START_BUDGET_MS
    : undefined;

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
      expect(advanced?.status).toBe('candidate');
      expect(advanced?.review_reason).toBe('Prepared for review queue.');

      const staged = await reopened.updateMemoryCandidateEntryStatus(id, {
        status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:05:00.000Z'),
        review_reason: 'Ready for explicit review decision.',
      });
      expect(staged?.status).toBe('staged_for_review');

      const rejected = await reopened.updateMemoryCandidateEntryStatus(id, {
        status: 'rejected',
        reviewed_at: new Date('2026-04-22T06:10:00.000Z'),
        review_reason: 'Insufficient provenance for durable memory.',
      });
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.review_reason).toBe('Insufficient provenance for durable memory.');

      await expect(reopened.createMemoryCandidateEntry({
        id: `${id}:direct-promoted`,
        scope_id: scopeId,
        candidate_type: 'fact',
        proposed_content: 'Direct promoted inserts should be blocked at the engine surface.',
        source_refs: ['User, direct message, 2026-04-23 11:00 AM KST'],
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.9,
        importance_score: 0.7,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'promoted' as any,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/memory-inbox',
        reviewed_at: null,
        review_reason: null,
      })).rejects.toThrow(/Cannot create memory candidate directly in promoted status/);

      const promotedId = `${id}:promoted`;
      await seedMemoryCandidate(reopened, promotedId, scopeId);
      expect((await reopened.updateMemoryCandidateEntryStatus(promotedId, {
        status: 'candidate',
        reviewed_at: new Date('2026-04-22T06:12:00.000Z'),
      }))?.status).toBe('candidate');
      expect((await reopened.updateMemoryCandidateEntryStatus(promotedId, {
        status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:14:00.000Z'),
      }))?.status).toBe('staged_for_review');
      const promoted = await reopened.promoteMemoryCandidateEntry(promotedId, {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:16:00.000Z'),
        review_reason: 'Promoted after passing preflight.',
      });
      expect(promoted?.status).toBe('promoted');
      expect(promoted?.review_reason).toBe('Promoted after passing preflight.');
      expect(await reopened.promoteMemoryCandidateEntry(promotedId, {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:16:30.000Z'),
        review_reason: 'Duplicate promotion should lose the expected-status race.',
      })).toBeNull();

      await expect(reopened.updateMemoryCandidateEntryStatus(promotedId, {
        status: 'rejected',
        reviewed_at: new Date('2026-04-22T06:17:00.000Z'),
        review_reason: 'Terminal promoted outcomes must remain immutable.',
      })).rejects.toThrow(/Cannot update memory candidate from promoted to rejected/);

      expect((await reopened.getMemoryCandidateEntry(promotedId))?.status).toBe('promoted');

      const replacementId = `${id}:replacement`;
      await seedMemoryCandidate(reopened, replacementId, scopeId);
      expect((await reopened.updateMemoryCandidateEntryStatus(replacementId, {
        status: 'candidate',
        reviewed_at: new Date('2026-04-22T06:18:00.000Z'),
      }))?.status).toBe('candidate');
      expect((await reopened.updateMemoryCandidateEntryStatus(replacementId, {
        status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:19:00.000Z'),
      }))?.status).toBe('staged_for_review');
      expect((await reopened.promoteMemoryCandidateEntry(replacementId, {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:20:00.000Z'),
        review_reason: 'Replacement candidate won review.',
      }))?.status).toBe('promoted');

      const invalidSupersessionId = `${promotedId}:invalid-supersession`;
      const invalidSupersession = await reopened.supersedeMemoryCandidateEntry({
        id: invalidSupersessionId,
        scope_id: 'workspace:bogus',
        superseded_candidate_id: replacementId,
        replacement_candidate_id: 'missing-replacement',
        expected_current_status: 'promoted',
        reviewed_at: new Date('2026-04-22T06:20:30.000Z'),
        review_reason: 'Invalid replacement should not be persisted.',
      });
      expect(invalidSupersession).toBeNull();
      expect((await reopened.getMemoryCandidateEntry(replacementId))?.status).toBe('promoted');
      expect(await reopened.getMemoryCandidateSupersessionEntry(invalidSupersessionId)).toBeNull();

      const supersession = await reopened.supersedeMemoryCandidateEntry({
        id: `${promotedId}:supersession`,
        scope_id: scopeId,
        superseded_candidate_id: promotedId,
        replacement_candidate_id: replacementId,
        expected_current_status: 'promoted',
        reviewed_at: new Date('2026-04-22T06:21:00.000Z'),
        review_reason: 'Newer promoted evidence replaced the older promoted candidate.',
      });
      expect(supersession?.replacement_candidate_id).toBe(replacementId);
      expect((await reopened.getMemoryCandidateEntry(promotedId))?.status).toBe('superseded');
      expect((await reopened.getMemoryCandidateSupersessionEntry(`${promotedId}:supersession`))?.superseded_candidate_id).toBe(promotedId);

      await reopened.disconnect();
      reopened = await harness.reopen();
      expect((await reopened.getMemoryCandidateEntry(promotedId))?.status).toBe('superseded');
      expect((await reopened.getMemoryCandidateSupersessionEntry(`${promotedId}:supersession`))?.superseded_candidate_id).toBe(promotedId);
      const contradiction = await reopened.createMemoryCandidateContradictionEntry({
        id: `${promotedId}:contradiction`,
        scope_id: scopeId,
        candidate_id: replacementId,
        challenged_candidate_id: promotedId,
        outcome: 'superseded',
        supersession_entry_id: `${promotedId}:supersession`,
        reviewed_at: new Date('2026-04-22T06:21:30.000Z'),
        review_reason: 'Contradiction record should persist across reopen.',
      });
      if (!contradiction) {
        throw new Error('Expected contradiction entry to be created');
      }
      expect(contradiction.outcome).toBe('superseded');
      expect(await reopened.createMemoryCandidateContradictionEntry({
        id: `${promotedId}:invalid-contradiction`,
        scope_id: 'workspace:bogus',
        candidate_id: replacementId,
        challenged_candidate_id: promotedId,
        outcome: 'unresolved',
        reviewed_at: new Date('2026-04-22T06:21:45.000Z'),
        review_reason: 'Cross-scope contradiction records should be rejected.',
      })).toBeNull();
      expect(await reopened.supersedeMemoryCandidateEntry({
        id: `${promotedId}:supersession-duplicate`,
        scope_id: scopeId,
        superseded_candidate_id: promotedId,
        replacement_candidate_id: replacementId,
        expected_current_status: 'promoted',
        reviewed_at: new Date('2026-04-22T06:22:00.000Z'),
        review_reason: 'Duplicate supersession should degrade to null.',
      })).toBeNull();

      await reopened.disconnect();
      reopened = await harness.reopen();
      expect((await reopened.getMemoryCandidateContradictionEntry(`${promotedId}:contradiction`))?.outcome).toBe('superseded');

      await reopened.deleteMemoryCandidateEntry(id);
      expect(await reopened.getMemoryCandidateEntry(id)).toBeNull();
    } finally {
      await reopened?.disconnect();
      await harness.cleanup();
    }
  }, timeoutMs);

  test(`${createHarness.name} refuses promotion when provenance refs are blank-only`, async () => {
    const harness = await createHarness();
    const scopeId = 'workspace:default';
    const id = `memory-candidate:${scopeId}:${harness.label}:blank-provenance`;

    try {
      await harness.engine.createMemoryCandidateEntry({
        id,
        scope_id: scopeId,
        candidate_type: 'fact',
        proposed_content: 'Blank-only provenance must not be promotable.',
        source_refs: ['   '],
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

      expect((await harness.engine.updateMemoryCandidateEntryStatus(id, {
        status: 'candidate',
        reviewed_at: new Date('2026-04-22T06:00:00.000Z'),
      }))?.status).toBe('candidate');
      expect((await harness.engine.updateMemoryCandidateEntryStatus(id, {
        status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:05:00.000Z'),
      }))?.status).toBe('staged_for_review');

      expect(await harness.engine.promoteMemoryCandidateEntry(id, {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:16:00.000Z'),
        review_reason: 'Blank provenance must not pass the engine CAS guard.',
      })).toBeNull();
      expect((await harness.engine.getMemoryCandidateEntry(id))?.status).toBe('staged_for_review');
    } finally {
      await harness.cleanup();
    }
  }, timeoutMs);
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

  test('postgres refuses promotion when provenance refs are blank-only', async () => {
    const scopeId = 'workspace:default';
    const id = `memory-candidate:${scopeId}:postgres:blank-provenance:${Date.now()}`;
    const engine = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await engine.createMemoryCandidateEntry({
        id,
        scope_id: scopeId,
        candidate_type: 'fact',
        proposed_content: 'Blank-only provenance must not be promotable.',
        source_refs: ['   '],
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

      expect((await engine.updateMemoryCandidateEntryStatus(id, {
        status: 'candidate',
        reviewed_at: new Date('2026-04-22T06:00:00.000Z'),
      }))?.status).toBe('candidate');
      expect((await engine.updateMemoryCandidateEntryStatus(id, {
        status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:05:00.000Z'),
      }))?.status).toBe('staged_for_review');

      expect(await engine.promoteMemoryCandidateEntry(id, {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-04-22T06:16:00.000Z'),
        review_reason: 'Blank provenance must not pass the engine CAS guard.',
      })).toBeNull();
      expect((await engine.getMemoryCandidateEntry(id))?.status).toBe('staged_for_review');
    } finally {
      if (!(engine as any)._sql) {
        await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      await engine.deleteMemoryCandidateEntry(id).catch(() => undefined);
      await engine.disconnect().catch(() => undefined);
    }
  });
} else {
  test.skip('postgres memory inbox persistence skipped: DATABASE_URL is not configured', () => {});
}
