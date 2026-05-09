import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { MemoryCandidateCreateStatus, MemoryCandidateEntryInput } from '../src/core/types.ts';
import {
  advanceMemoryCandidateStatus,
  createMemoryCandidateEntryWithStatusEvent,
  MemoryInboxServiceError,
  preflightPromoteMemoryCandidate,
  rejectMemoryCandidateEntry,
} from '../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../src/core/services/memory-inbox-promotion-service.ts';
import { supersedeMemoryCandidateEntry } from '../src/core/services/memory-inbox-supersession-service.ts';

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
    proposed_content: 'Context maps can propose a note update candidate.',
    source_refs: ['User, direct message, 2026-04-22 3:01 PM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.95,
    importance_score: 0.8,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status,
    target_object_type: 'curated_note',
    target_object_id: 'concepts/note-manifest',
    reviewed_at: null,
    review_reason: null,
    ...overrides,
  });
}

async function seedPromotedCandidate(
  engine: SQLiteEngine,
  id: string,
  scopeId = 'workspace:default',
) {
  await seedCandidate(engine, id, 'captured', { scope_id: scopeId });
  await advanceMemoryCandidateStatus(engine, {
    id,
    next_status: 'candidate',
  });
  await advanceMemoryCandidateStatus(engine, {
    id,
    next_status: 'staged_for_review',
  });
  return promoteMemoryCandidateEntry(engine, {
    id,
    review_reason: `Promoted ${id} for supersession testing.`,
  });
}

test('memory inbox service records created and transition events with interaction ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-status-events-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await createMemoryCandidateEntryWithStatusEvent(engine, {
      id: 'candidate-status-events-service',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Service should record candidate status events.',
      source_refs: ['User, direct message, 2026-04-25 9:00 AM KST'],
      generated_by: 'manual',
      extraction_kind: 'manual',
      confidence_score: 0.9,
      importance_score: 0.7,
      recurrence_score: 0.1,
      sensitivity: 'work',
      status: 'captured',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/status-events',
      interaction_id: 'trace-service-status-events',
    });
    await advanceMemoryCandidateStatus(engine, {
      id: 'candidate-status-events-service',
      next_status: 'candidate',
      interaction_id: 'trace-service-status-events',
    });
    await advanceMemoryCandidateStatus(engine, {
      id: 'candidate-status-events-service',
      next_status: 'staged_for_review',
      interaction_id: 'trace-service-status-events',
      review_reason: 'Ready for review.',
    });
    await rejectMemoryCandidateEntry(engine, {
      id: 'candidate-status-events-service',
      interaction_id: 'trace-service-status-events',
      review_reason: 'Rejected for service status-event test.',
    });

    const events = await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'candidate-status-events-service',
      limit: 10,
    });
    expect(events.map((event) => event.event_kind).sort()).toEqual([
      'advanced',
      'advanced',
      'created',
      'rejected',
    ]);
    expect(events.every((event) => event.interaction_id === 'trace-service-status-events')).toBe(true);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service advances captured candidate to candidate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-candidate-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-1', 'captured');

    const updated = await advanceMemoryCandidateStatus(engine, {
      id: 'candidate-1',
      next_status: 'candidate',
    });

    expect(updated.status).toBe('candidate');
    expect(updated.reviewed_at).toBeNull();
    expect(updated.review_reason).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service advances candidate to staged_for_review with review metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-staged-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-2', 'candidate');

    const updated = await advanceMemoryCandidateStatus(engine, {
      id: 'candidate-2',
      next_status: 'staged_for_review',
      review_reason: 'Escalated for bounded manual review.',
    });

    expect(updated.status).toBe('staged_for_review');
    expect(updated.review_reason).toBe('Escalated for bounded manual review.');
    expect(updated.reviewed_at).not.toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox supersession service forwards interaction_id to the engine call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-supersession-interaction-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'superseded-interaction');
    await seedPromotedCandidate(engine, 'replacement-interaction');

    const originalSupersede = engine.supersedeMemoryCandidateEntry.bind(engine);
    let capturedInput: Record<string, unknown> | null = null;
    engine.supersedeMemoryCandidateEntry = async (input: any) => {
      capturedInput = input;
      return originalSupersede(input);
    };

    await supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'superseded-interaction',
      replacement_candidate_id: 'replacement-interaction',
      interaction_id: 'interaction-456',
      review_reason: 'Forward interaction context into supersession storage.',
    });

    expect(capturedInput).toMatchObject({
      interaction_id: 'interaction-456',
    });
    expect(await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'superseded-interaction',
      event_kind: 'superseded',
      interaction_id: 'interaction-456',
      limit: 10,
    })).toHaveLength(1);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service preserves explicit null reviewed_at when staging for review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-null-reviewed-at-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-2b', 'candidate');

    const updated = await advanceMemoryCandidateStatus(engine, {
      id: 'candidate-2b',
      next_status: 'staged_for_review',
      reviewed_at: null,
      review_reason: 'Escalated without stamping review time yet.',
    });

    expect(updated.status).toBe('staged_for_review');
    expect(updated.reviewed_at).toBeNull();
    expect(updated.review_reason).toBe('Escalated without stamping review time yet.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service rejects skipped transitions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-skip-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-3', 'captured');

    await expect(advanceMemoryCandidateStatus(engine, {
      id: 'candidate-3',
      next_status: 'staged_for_review',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service rejects backward transitions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-backward-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-4', 'staged_for_review');

    await expect(advanceMemoryCandidateStatus(engine, {
      id: 'candidate-4',
      next_status: 'candidate',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service rejects missing candidate ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-missing-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await expect(advanceMemoryCandidateStatus(engine, {
      id: 'missing-candidate',
      next_status: 'candidate',
    })).rejects.toBeInstanceOf(MemoryInboxServiceError);
    await expect(advanceMemoryCandidateStatus(engine, {
      id: 'missing-candidate',
      next_status: 'candidate',
    })).rejects.toMatchObject({
      code: 'memory_candidate_not_found',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service rejects a staged candidate with review metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-reject-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-5', 'staged_for_review');

    const updated = await rejectMemoryCandidateEntry(engine, {
      id: 'candidate-5',
      review_reason: 'Insufficient provenance for durable memory.',
    });

    expect(updated.status).toBe('rejected');
    expect(updated.review_reason).toBe('Insufficient provenance for durable memory.');
    expect(updated.reviewed_at).not.toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service preserves explicit null reviewed_at on rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-reject-null-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-6', 'staged_for_review');

    const updated = await rejectMemoryCandidateEntry(engine, {
      id: 'candidate-6',
      reviewed_at: null,
      review_reason: 'Explicit null review time stays preserved on rejection.',
    });

    expect(updated.status).toBe('rejected');
    expect(updated.reviewed_at).toBeNull();
    expect(updated.review_reason).toBe('Explicit null review time stays preserved on rejection.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service rejects race-lost rejection attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-reject-race-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-reject-race', 'staged_for_review');

    const originalUpdate = engine.updateMemoryCandidateEntryStatus.bind(engine);
    engine.updateMemoryCandidateEntryStatus = async () => null;

    await expect(rejectMemoryCandidateEntry(engine, {
      id: 'candidate-reject-race',
      review_reason: 'A concurrent promotion already won the governance decision.',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });

    expect((await engine.getMemoryCandidateEntry('candidate-reject-race'))?.status).toBe('staged_for_review');
    engine.updateMemoryCandidateEntryStatus = originalUpdate;
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service rejects rejection before staged_for_review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-reject-invalid-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-7', 'candidate');

    await expect(rejectMemoryCandidateEntry(engine, {
      id: 'candidate-7',
      review_reason: 'Should not reject before review stage.',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service allows promotion preflight for staged candidates with provenance and target binding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-preflight-allow-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-8', 'staged_for_review');

    const result = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-8' });

    expect(result.decision).toBe('allow');
    expect(result.reasons).toEqual(['candidate_ready_for_promotion']);
    expect(result.summary_lines).toContain('Promotion preflight decision: allow.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service denies promotion preflight without provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-preflight-provenance-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-9', 'staged_for_review', {
      source_refs: [],
    });

    const result = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-9' });

    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('candidate_missing_provenance');
    expect(result.summary_lines).toContain('Reasons: candidate is missing provenance.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service denies promotion preflight when provenance strings are blank', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-preflight-blank-provenance-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-9b', 'staged_for_review', {
      source_refs: [''],
    });

    const result = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-9b' });

    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('candidate_missing_provenance');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service denies promotion preflight without target binding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-preflight-target-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-10', 'staged_for_review', {
      target_object_type: null,
      target_object_id: null,
    });

    const result = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-10' });

    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('candidate_missing_target_object');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service denies promotion preflight when target object ids are blank', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-preflight-blank-target-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-10b', 'staged_for_review', {
      target_object_id: '   ',
    });

    const result = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-10b' });

    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('candidate_missing_target_object');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service denies promotion preflight on scope conflicts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-preflight-scope-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-11', 'staged_for_review', {
      sensitivity: 'personal',
      target_object_type: 'curated_note',
    });
    await seedCandidate(engine, 'candidate-12', 'staged_for_review', {
      sensitivity: 'work',
      target_object_type: 'profile_memory',
      target_object_id: 'profile:preferences',
    });

    const workVisibleConflict = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-11' });
    const personalOnlyConflict = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-12' });

    expect(workVisibleConflict.decision).toBe('deny');
    expect(workVisibleConflict.reasons).toContain('candidate_scope_conflict');
    expect(personalOnlyConflict.decision).toBe('deny');
    expect(personalOnlyConflict.reasons).toContain('candidate_scope_conflict');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service defers promotion preflight for unknown sensitivity and procedure revalidation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-preflight-defer-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-13', 'staged_for_review', {
      sensitivity: 'unknown',
    });
    await seedCandidate(engine, 'candidate-14', 'staged_for_review', {
      candidate_type: 'procedure',
      target_object_type: 'procedure',
      target_object_id: 'procedures/rebuild-context-map',
    });
    await seedCandidate(engine, 'candidate-16', 'staged_for_review', {
      candidate_type: 'fact',
      target_object_type: 'other',
      target_object_id: 'misc/unknown-target',
    });

    const unknownSensitivity = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-13' });
    const procedureRevalidation = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-14' });
    const unknownTarget = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-16' });

    expect(unknownSensitivity.decision).toBe('defer');
    expect(unknownSensitivity.reasons).toContain('candidate_unknown_sensitivity');
    expect(unknownSensitivity.summary_lines).toContain('Reasons: candidate sensitivity is unknown.');
    expect(procedureRevalidation.decision).toBe('defer');
    expect(procedureRevalidation.reasons).toContain('candidate_requires_revalidation');
    expect(unknownTarget.decision).toBe('defer');
    expect(unknownTarget.reasons).toContain('candidate_requires_revalidation');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service allows fact candidates that target procedures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-preflight-procedure-target-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-17', 'staged_for_review', {
      candidate_type: 'fact',
      target_object_type: 'procedure',
      target_object_id: 'procedures/rebuild-context-map',
    });

    const result = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-17' });

    expect(result.decision).toBe('allow');
    expect(result.reasons).toEqual(['candidate_ready_for_promotion']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox service rejects promotion preflight before staged_for_review and on missing ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-preflight-missing-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-15', 'candidate');

    const notReady = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-15' });
    expect(notReady.decision).toBe('deny');
    expect(notReady.reasons).toContain('candidate_not_staged_for_review');

    await expect(preflightPromoteMemoryCandidate(engine, {
      id: 'missing-candidate',
    })).rejects.toBeInstanceOf(MemoryInboxServiceError);
    await expect(preflightPromoteMemoryCandidate(engine, {
      id: 'missing-candidate',
    })).rejects.toMatchObject({
      code: 'memory_candidate_not_found',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox promotion service promotes staged candidates that pass preflight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-promote-allow-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-18', 'staged_for_review');

    const promoted = await promoteMemoryCandidateEntry(engine, {
      id: 'candidate-18',
      review_reason: 'Promoted after passing promotion preflight.',
    });

    expect(promoted.status).toBe('promoted');
    expect(promoted.review_reason).toBe('Promoted after passing promotion preflight.');
    expect(promoted.reviewed_at).not.toBeNull();
    expect(await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'candidate-18',
      event_kind: 'promoted',
      limit: 10,
    })).toHaveLength(1);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox promotion service preserves explicit null reviewed_at', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-promote-null-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-19', 'staged_for_review');

    const promoted = await promoteMemoryCandidateEntry(engine, {
      id: 'candidate-19',
      reviewed_at: null,
      review_reason: 'Explicit null should remain preserved.',
    });

    expect(promoted.status).toBe('promoted');
    expect(promoted.reviewed_at).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox promotion service rejects invalid reviewed_at Date inputs with a controlled error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-promote-date-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-promote-invalid-date', 'staged_for_review');

    await expect(promoteMemoryCandidateEntry(engine, {
      id: 'candidate-promote-invalid-date',
      reviewed_at: new Date('not-a-date'),
      review_reason: 'Invalid date should be rejected before persistence.',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox promotion service rejects non-staged or non-promotable candidates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-promote-invalid-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-20', 'candidate');
    await seedCandidate(engine, 'candidate-21', 'staged_for_review', {
      source_refs: [],
    });

    await expect(promoteMemoryCandidateEntry(engine, {
      id: 'candidate-20',
      review_reason: 'Should not promote before staged review.',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });

    await expect(promoteMemoryCandidateEntry(engine, {
      id: 'candidate-21',
      review_reason: 'Should not promote without provenance.',
    })).rejects.toMatchObject({
      code: 'promotion_preflight_failed',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox promotion service rejects missing ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-promote-missing-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await expect(promoteMemoryCandidateEntry(engine, {
      id: 'missing-promoted-candidate',
    })).rejects.toMatchObject({
      code: 'memory_candidate_not_found',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox supersession service supersedes promoted candidates with an explicit replacement link', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-supersede-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'candidate-old');
    await seedPromotedCandidate(engine, 'candidate-new');

    const result = await supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'candidate-old',
      replacement_candidate_id: 'candidate-new',
      review_reason: 'Newer promoted evidence replaced the earlier candidate.',
    });

    expect(result.superseded_candidate.status).toBe('superseded');
    expect(result.replacement_candidate.id).toBe('candidate-new');
    expect(result.supersession_entry.superseded_candidate_id).toBe('candidate-old');
    expect(await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'candidate-old',
      event_kind: 'superseded',
      limit: 10,
    })).toHaveLength(1);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox supersession service can supersede staged candidates with a promoted replacement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-supersede-staged-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedCandidate(engine, 'candidate-staged-old', 'staged_for_review');
    await seedPromotedCandidate(engine, 'candidate-staged-new');

    const result = await supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'candidate-staged-old',
      replacement_candidate_id: 'candidate-staged-new',
      review_reason: 'Promoted replacement superseded the older staged candidate.',
    });

    expect(result.superseded_candidate.status).toBe('superseded');
    expect(result.replacement_candidate.status).toBe('promoted');
    expect(result.supersession_entry.superseded_candidate_id).toBe('candidate-staged-old');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox supersession service rejects invalid reviewed_at Date inputs with a controlled error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-supersede-date-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'candidate-supersede-invalid-date-old');
    await seedPromotedCandidate(engine, 'candidate-supersede-invalid-date-new');

    await expect(supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'candidate-supersede-invalid-date-old',
      replacement_candidate_id: 'candidate-supersede-invalid-date-new',
      reviewed_at: new Date('not-a-date'),
      review_reason: 'Invalid date should be rejected before persistence.',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox supersession service translates duplicate supersession races into invalid_status_transition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-supersede-duplicate-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'candidate-duplicate-old');
    await seedPromotedCandidate(engine, 'candidate-duplicate-new');

    await supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'candidate-duplicate-old',
      replacement_candidate_id: 'candidate-duplicate-new',
      review_reason: 'First supersession should succeed.',
    });

    await expect(supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'candidate-duplicate-old',
      replacement_candidate_id: 'candidate-duplicate-new',
      review_reason: 'Duplicate supersession should degrade cleanly.',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox supersession service rejects invalid replacement routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-supersede-invalid-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'candidate-valid-old');
    await seedPromotedCandidate(engine, 'candidate-valid-new');
    await seedPromotedCandidate(engine, 'candidate-cross-scope-old');
    await seedPromotedCandidate(engine, 'candidate-cross-scope-new', 'workspace:other');
    await seedCandidate(engine, 'candidate-not-promoted', 'staged_for_review');

    await expect(supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'candidate-valid-old',
      replacement_candidate_id: 'candidate-valid-old',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });

    await expect(supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'candidate-valid-old',
      replacement_candidate_id: 'candidate-not-promoted',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });

    await expect(supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'candidate-cross-scope-old',
      replacement_candidate_id: 'candidate-cross-scope-new',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox supersession service rejects race-lost supersession attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-service-supersede-race-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'candidate-race-old');
    await seedPromotedCandidate(engine, 'candidate-race-new');

    const originalSupersede = engine.supersedeMemoryCandidateEntry.bind(engine);
    engine.supersedeMemoryCandidateEntry = async () => null;

    await expect(supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'candidate-race-old',
      replacement_candidate_id: 'candidate-race-new',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });

    expect((await engine.getMemoryCandidateEntry('candidate-race-old'))?.status).toBe('promoted');
    engine.supersedeMemoryCandidateEntry = originalSupersede;
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
