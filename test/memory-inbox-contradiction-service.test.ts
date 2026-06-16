import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import {
  advanceMemoryCandidateStatus,
  verifyMemoryCandidateEntry,
} from '../src/core/services/memory-inbox-service.ts';
import { resolveMemoryCandidateContradiction } from '../src/core/services/memory-inbox-contradiction-service.ts';
import { promoteMemoryCandidateEntry } from '../src/core/services/memory-inbox-promotion-service.ts';

test('memory inbox contradiction service resolves rejected, unresolved, and superseded outcomes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-contradiction-service-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await seedPromotedCandidate(engine, 'challenged-promoted');
    await seedStagedCandidate(engine, 'challenger-rejected');
    await seedStagedCandidate(engine, 'challenger-unresolved');
    await seedPromotedCandidate(engine, 'challenger-superseding');

    const rejected = await resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'challenger-rejected',
      challenged_candidate_id: 'challenged-promoted',
      outcome: 'rejected',
      review_reason: 'Contradicted by stronger existing evidence.',
    });
    expect(rejected.contradiction_entry.outcome).toBe('rejected');
    expect(rejected.candidate.status).toBe('rejected');
    expect(rejected.challenged_candidate.status).toBe('promoted');
    expect(rejected.supersession_entry).toBeNull();

    const unresolved = await resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'challenger-unresolved',
      challenged_candidate_id: 'challenged-promoted',
      outcome: 'unresolved',
      review_reason: 'Conflict stays open pending more evidence.',
    });
    expect(unresolved.contradiction_entry.outcome).toBe('unresolved');
    expect(unresolved.candidate.status).toBe('staged_for_review');
    expect(unresolved.challenged_candidate.status).toBe('promoted');
    expect(unresolved.supersession_entry).toBeNull();

    const superseded = await resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'challenger-superseding',
      challenged_candidate_id: 'challenged-promoted',
      outcome: 'superseded',
      review_reason: 'Newer promoted evidence replaces the older candidate.',
    });
    expect(superseded.contradiction_entry.outcome).toBe('superseded');
    expect(superseded.candidate.status).toBe('promoted');
    expect(superseded.challenged_candidate.status).toBe('superseded');
    expect(superseded.supersession_entry?.replacement_candidate_id).toBe('challenger-superseding');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox contradiction service forwards interaction_id to supersession and contradiction engine calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-contradiction-service-interaction-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await seedPromotedCandidate(engine, 'challenged-interaction');
    await seedPromotedCandidate(engine, 'challenger-interaction');

    const originalSupersede = engine.supersedeMemoryCandidateEntry.bind(engine);
    const originalCreateContradiction = engine.createMemoryCandidateContradictionEntry.bind(engine);
    let capturedSupersedeInput: Record<string, unknown> | null = null;
    let capturedContradictionInput: Record<string, unknown> | null = null;
    engine.supersedeMemoryCandidateEntry = async (input: any) => {
      capturedSupersedeInput = input;
      return originalSupersede(input);
    };
    engine.createMemoryCandidateContradictionEntry = async (input: any) => {
      capturedContradictionInput = input;
      return originalCreateContradiction(input);
    };

    await resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'challenger-interaction',
      challenged_candidate_id: 'challenged-interaction',
      outcome: 'superseded',
      interaction_id: 'interaction-789',
      review_reason: 'Forward interaction context through contradiction resolution.',
    });

    expect(capturedSupersedeInput).toMatchObject({
      interaction_id: 'interaction-789',
    });
    expect(capturedContradictionInput).toMatchObject({
      interaction_id: 'interaction-789',
    });
    expect(await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'challenged-interaction',
      event_kind: 'superseded',
      interaction_id: 'interaction-789',
      limit: 10,
    })).toHaveLength(1);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox contradiction service records rejected status events with contradiction interaction ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-contradiction-service-rejected-event-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await seedPromotedCandidate(engine, 'challenged-rejected-event');
    await seedStagedCandidate(engine, 'challenger-rejected-event');

    const result = await resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'challenger-rejected-event',
      challenged_candidate_id: 'challenged-rejected-event',
      outcome: 'rejected',
      interaction_id: 'interaction-rejected-event',
      review_reason: 'Rejected branch should preserve contradiction interaction context.',
    });

    expect(result.contradiction_entry.interaction_id).toBe('interaction-rejected-event');
    expect(await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'challenger-rejected-event',
      event_kind: 'rejected',
      interaction_id: 'interaction-rejected-event',
      limit: 10,
    })).toHaveLength(1);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox contradiction service rejects invalid contradiction routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-contradiction-service-invalid-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await seedPromotedCandidate(engine, 'candidate-same');
    await seedPromotedCandidate(engine, 'candidate-cross-scope', 'workspace:other');
    await seedStagedCandidate(engine, 'candidate-not-promoted');
    await seedPromotedCandidate(engine, 'candidate-promoted-reject');
    await seedPromotedCandidate(engine, 'candidate-promoted-challenged');
    await seedStagedCandidate(engine, 'candidate-staged-supersede');
    await seedPromotedCandidate(engine, 'candidate-promoted-replacement');

    await expect(resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'candidate-same',
      challenged_candidate_id: 'candidate-same',
      outcome: 'unresolved',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });

    await expect(resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'candidate-not-promoted',
      challenged_candidate_id: 'candidate-cross-scope',
      outcome: 'superseded',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });

    await expect(resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'candidate-not-promoted',
      challenged_candidate_id: 'candidate-cross-scope',
      outcome: 'unresolved',
      reviewed_at: '2026-99-99T25:61:61Z',
    })).rejects.toMatchObject({
      code: 'invalid_status_transition',
    });

    await expect(resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'candidate-promoted-reject',
      challenged_candidate_id: 'candidate-promoted-challenged',
      outcome: 'rejected',
    })).rejects.toThrow(/rejected outcome requires the candidate to be staged_for_review/);

    await expect(resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'candidate-staged-supersede',
      challenged_candidate_id: 'candidate-promoted-replacement',
      outcome: 'superseded',
    })).rejects.toThrow(/superseded outcome requires the replacement candidate to be promoted/);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox contradiction service rejects invalid reviewed_at Date inputs with a controlled error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-contradiction-service-date-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'challenged-invalid-date');
    await seedStagedCandidate(engine, 'challenger-invalid-date');

    await expect(resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'challenger-invalid-date',
      challenged_candidate_id: 'challenged-invalid-date',
      outcome: 'rejected',
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

test('memory inbox contradiction service rolls back rejected outcomes when contradiction persistence fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-contradiction-service-reject-rollback-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'challenged-rollback-old');
    await seedStagedCandidate(engine, 'challenger-rollback-rejected');

    const originalCreate = engine.createMemoryCandidateContradictionEntry.bind(engine);
    engine.createMemoryCandidateContradictionEntry = async () => {
      throw new Error('simulated contradiction persistence failure');
    };

    await expect(resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'challenger-rollback-rejected',
      challenged_candidate_id: 'challenged-rollback-old',
      outcome: 'rejected',
      review_reason: 'Should roll back the rejected state.',
    })).rejects.toThrow(/simulated contradiction persistence failure/);

    expect((await engine.getMemoryCandidateEntry('challenger-rollback-rejected'))?.status).toBe('staged_for_review');
    engine.createMemoryCandidateContradictionEntry = originalCreate;
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox contradiction service rolls back superseded outcomes when contradiction persistence fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-contradiction-service-supersede-rollback-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await seedPromotedCandidate(engine, 'challenged-rollback-superseded');
    await seedPromotedCandidate(engine, 'challenger-rollback-superseding');

    const originalCreate = engine.createMemoryCandidateContradictionEntry.bind(engine);
    engine.createMemoryCandidateContradictionEntry = async () => {
      throw new Error('simulated contradiction persistence failure');
    };

    await expect(resolveMemoryCandidateContradiction(engine, {
      candidate_id: 'challenger-rollback-superseding',
      challenged_candidate_id: 'challenged-rollback-superseded',
      outcome: 'superseded',
      review_reason: 'Should roll back the superseded state.',
    })).rejects.toThrow(/simulated contradiction persistence failure/);

    expect((await engine.getMemoryCandidateEntry('challenged-rollback-superseded'))?.status).toBe('promoted');
    expect(await engine.getMemoryCandidateSupersessionEntry('missing')).toBeNull();
    engine.createMemoryCandidateContradictionEntry = originalCreate;
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function seedCapturedCandidate(engine: SQLiteEngine, id: string, scopeId = 'workspace:default') {
  await engine.createMemoryCandidateEntry({
    id,
    scope_id: scopeId,
    candidate_type: 'fact',
    proposed_content: `Candidate ${id} participates in contradiction review.`,
    source_refs: ['User, direct message, 2026-04-24 01:10 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.9,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/memory-inbox',
    reviewed_at: null,
    review_reason: null,
  });
}

async function seedStagedCandidate(engine: SQLiteEngine, id: string, scopeId = 'workspace:default') {
  await seedCapturedCandidate(engine, id, scopeId);
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'staged_for_review' });
}

async function seedPromotedCandidate(engine: SQLiteEngine, id: string, scopeId = 'workspace:default') {
  await seedStagedCandidate(engine, id, scopeId);
  await verifyMemoryCandidateEntry(engine, {
    id,
    verification_status: 'verified',
    verification_method: 'source_recheck',
    verification_evidence: `Verified contradiction fixture ${id}.`,
    verification_source_refs: [`Fixture verification for ${id}`],
    verified_at: '2026-06-16T00:00:00Z',
  });
  await promoteMemoryCandidateEntry(engine, { id, review_reason: `Promoted ${id} for contradiction testing.` });
}
