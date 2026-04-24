import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { MemoryCandidateCreateStatus, MemoryCandidateEntryInput } from '../src/core/types.ts';
import { advanceMemoryCandidateStatus } from '../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../src/core/services/memory-inbox-promotion-service.ts';
import { recordCanonicalHandoff } from '../src/core/services/canonical-handoff-service.ts';

async function seedCandidate(
  engine: SQLiteEngine,
  id: string,
  status: MemoryCandidateCreateStatus = 'captured',
  overrides: Partial<MemoryCandidateEntryInput> = {},
) {
  return engine.createMemoryCandidateEntry({
    id,
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: 'Reviewed candidate is ready for canonical handoff.',
    source_refs: ['User, direct message, 2026-04-23 4:00 PM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.95,
    importance_score: 0.8,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status,
    target_object_type: 'curated_note',
    target_object_id: 'concepts/canonical-handoff',
    reviewed_at: null,
    review_reason: null,
    ...overrides,
  });
}

async function seedPromotedCandidate(engine: SQLiteEngine, id: string, overrides: Partial<MemoryCandidateEntryInput> = {}) {
  await seedCandidate(engine, id, 'captured', overrides);
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'staged_for_review' });
  const hasCanonicalTarget = overrides.target_object_type != null && overrides.target_object_id != null;
  if (hasCanonicalTarget) {
    return promoteMemoryCandidateEntry(engine, {
      id,
      review_reason: `Promoted ${id} for canonical handoff.`,
    });
  }
  return engine.promoteMemoryCandidateEntry(id, {
    expected_current_status: 'staged_for_review',
    review_reason: `Promoted ${id} for canonical handoff.`,
  });
}

test('canonical handoff service records explicit handoff rows for promoted candidates without mutating the candidate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-handoff-service-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'candidate-handoff');
    const before = await engine.getMemoryCandidateEntry('candidate-handoff');

    const result = await recordCanonicalHandoff(engine, {
      candidate_id: 'candidate-handoff',
      review_reason: 'Ready for explicit canonical handoff.',
    });

    expect(result.candidate.id).toBe('candidate-handoff');
    expect(result.handoff.target_object_type).toBe('curated_note');
    expect(result.handoff.target_object_id).toBe('concepts/canonical-handoff');
    expect(result.handoff.source_refs).toEqual(['User, direct message, 2026-04-23 4:00 PM KST']);

    const after = await engine.getMemoryCandidateEntry('candidate-handoff');
    expect(after).toEqual(before);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical handoff service forwards interaction_id to the engine call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-handoff-service-interaction-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'candidate-interaction');

    const originalCreate = engine.createCanonicalHandoffEntry.bind(engine);
    let capturedInput: Record<string, unknown> | null = null;
    engine.createCanonicalHandoffEntry = async (input: any) => {
      capturedInput = input;
      return originalCreate(input);
    };

    await recordCanonicalHandoff(engine, {
      candidate_id: 'candidate-interaction',
      interaction_id: 'interaction-123',
      review_reason: 'Forward interaction context into canonical handoff storage.',
    });

    expect(capturedInput).toMatchObject({
      interaction_id: 'interaction-123',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical handoff service rejects non-promoted, null-target, and duplicate handoff routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-handoff-service-invalid-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-staged', 'staged_for_review');
    await seedPromotedCandidate(engine, 'candidate-null-target', {
      target_object_type: null,
      target_object_id: null,
    });
    await seedPromotedCandidate(engine, 'candidate-duplicate');

    await expect(recordCanonicalHandoff(engine, {
      candidate_id: 'candidate-staged',
    })).rejects.toMatchObject({ code: 'invalid_status_transition' });

    await expect(recordCanonicalHandoff(engine, {
      candidate_id: 'candidate-null-target',
    })).rejects.toMatchObject({ code: 'invalid_status_transition' });

    await recordCanonicalHandoff(engine, { candidate_id: 'candidate-duplicate' });
    await expect(recordCanonicalHandoff(engine, {
      candidate_id: 'candidate-duplicate',
    })).rejects.toMatchObject({ code: 'invalid_status_transition' });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical handoff service rejects invalid reviewed_at Date inputs with a controlled error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-handoff-service-date-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'candidate-invalid-date');
    await seedPromotedCandidate(engine, 'candidate-impossible-date');

    await expect(recordCanonicalHandoff(engine, {
      candidate_id: 'candidate-invalid-date',
      reviewed_at: new Date('not-a-date'),
    })).rejects.toMatchObject({ code: 'invalid_status_transition' });

    await expect(recordCanonicalHandoff(engine, {
      candidate_id: 'candidate-impossible-date',
      reviewed_at: '2026-02-30T10:00:00Z',
    })).rejects.toMatchObject({ code: 'invalid_status_transition' });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
