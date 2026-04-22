import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { advanceMemoryCandidateStatus, MemoryInboxServiceError } from '../src/core/services/memory-inbox-service.ts';

async function seedCandidate(engine: SQLiteEngine, id: string, status: 'captured' | 'candidate' | 'staged_for_review' = 'captured') {
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
  });
}

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
