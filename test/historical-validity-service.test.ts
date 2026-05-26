import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { advanceMemoryCandidateStatus } from '../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../src/core/services/memory-inbox-promotion-service.ts';
import { recordCanonicalHandoff } from '../src/core/services/canonical-handoff-service.ts';
import { assessHistoricalValidity } from '../src/core/services/historical-validity-service.ts';
import { supersedeMemoryCandidateEntry } from '../src/core/services/memory-inbox-supersession-service.ts';

const FIXED_NOW = new Date('2026-04-25T00:00:00.000Z');

test('historical validity service allows a recent handed-off candidate with no same-scope competitors', async () => {
  const harness = await createHarness('allow');

  try {
    await seedPromotedCandidate(harness.engine, {
      id: 'candidate-current',
      scope_id: 'workspace:default',
      reviewed_at: '2026-04-23T10:00:00.000Z',
    });
    await recordCanonicalHandoff(harness.engine, {
      candidate_id: 'candidate-current',
      reviewed_at: '2026-04-23T10:05:00.000Z',
    });

    const result = await assessHistoricalValidity(harness.engine, { candidate_id: 'candidate-current', now: FIXED_NOW });

    expect(result.decision).toBe('allow');
    expect(result.stale_claim).toBe(false);
    expect(result.recommended_fallback).toBe('none');
    expect(result.reasons).toEqual(['candidate_currently_valid']);
  } finally {
    await harness.cleanup();
  }
});

test('historical validity service defers stale claims when the review window expired', async () => {
  const harness = await createHarness('stale');

  try {
    await seedPromotedCandidate(harness.engine, {
      id: 'candidate-stale',
      scope_id: 'workspace:default',
      reviewed_at: '2026-02-01T10:00:00.000Z',
    });
    await recordCanonicalHandoff(harness.engine, {
      candidate_id: 'candidate-stale',
      reviewed_at: '2026-02-01T10:05:00.000Z',
    });

    const result = await assessHistoricalValidity(harness.engine, { candidate_id: 'candidate-stale', now: FIXED_NOW });

    expect(result.decision).toBe('defer');
    expect(result.stale_claim).toBe(true);
    expect(result.recommended_fallback).toBe('none');
    expect(result.reasons).toContain('candidate_review_window_expired');
  } finally {
    await harness.cleanup();
  }
});

test('historical validity service denies older handoffs when a newer promoted peer exists in the same scope and target', async () => {
  const harness = await createHarness('supersede');

  try {
    await seedPromotedCandidate(harness.engine, {
      id: 'candidate-older',
      scope_id: 'workspace:default',
      reviewed_at: '2026-04-20T10:00:00.000Z',
    });
    await recordCanonicalHandoff(harness.engine, {
      candidate_id: 'candidate-older',
      reviewed_at: '2026-04-20T10:05:00.000Z',
    });

    await seedPromotedCandidate(harness.engine, {
      id: 'candidate-newer',
      scope_id: 'workspace:default',
      reviewed_at: '2026-04-23T10:00:00.000Z',
    });
    await recordCanonicalHandoff(harness.engine, {
      candidate_id: 'candidate-newer',
      reviewed_at: '2026-04-23T10:05:00.000Z',
    });

    await seedPromotedCandidate(harness.engine, {
      id: 'candidate-other-scope',
      scope_id: 'workspace:other',
      reviewed_at: '2026-04-24T10:00:00.000Z',
    });
    await recordCanonicalHandoff(harness.engine, {
      candidate_id: 'candidate-other-scope',
      reviewed_at: '2026-04-24T10:05:00.000Z',
    });

    const result = await assessHistoricalValidity(harness.engine, { candidate_id: 'candidate-older', now: FIXED_NOW });

    expect(result.decision).toBe('deny');
    expect(result.stale_claim).toBe(true);
    expect(result.recommended_fallback).toBe('supersede');
    expect(result.reasons).toContain('newer_promoted_candidate_exists');
  } finally {
    await harness.cleanup();
  }
});

test('historical validity service defers when a competing staged candidate is under review for the same scope and target', async () => {
  const harness = await createHarness('conflict');

  try {
    await seedPromotedCandidate(harness.engine, {
      id: 'candidate-reviewed',
      scope_id: 'workspace:default',
      reviewed_at: '2026-04-23T10:00:00.000Z',
    });
    await recordCanonicalHandoff(harness.engine, {
      candidate_id: 'candidate-reviewed',
      reviewed_at: '2026-04-23T10:05:00.000Z',
    });

    await seedStagedCandidate(harness.engine, {
      id: 'candidate-competing',
      scope_id: 'workspace:default',
    });

    const result = await assessHistoricalValidity(harness.engine, { candidate_id: 'candidate-reviewed', now: FIXED_NOW });

    expect(result.decision).toBe('defer');
    expect(result.stale_claim).toBe(false);
    expect(result.recommended_fallback).toBe('unresolved_conflict');
    expect(result.reasons).toContain('competing_candidate_under_review');
  } finally {
    await harness.cleanup();
  }
});

test('historical validity service denies non-promoted and missing-handoff candidates explicitly', async () => {
  const harness = await createHarness('preconditions');

  try {
    await harness.engine.createMemoryCandidateEntry({
      id: 'candidate-not-promoted',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Not yet promoted.',
      source_refs: ['User, direct message, 2026-04-24 8:20 AM KST'],
      generated_by: 'manual',
      extraction_kind: 'manual',
      confidence_score: 0.8,
      importance_score: 0.6,
      recurrence_score: 0.1,
      sensitivity: 'work',
      status: 'candidate',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/historical-validity-preconditions',
      reviewed_at: null,
      review_reason: null,
    });

    await seedPromotedCandidate(harness.engine, {
      id: 'candidate-no-handoff',
      scope_id: 'workspace:default',
      reviewed_at: '2026-04-23T10:00:00.000Z',
    });

    const notPromoted = await assessHistoricalValidity(harness.engine, { candidate_id: 'candidate-not-promoted', now: FIXED_NOW });
    expect(notPromoted.decision).toBe('deny');
    expect(notPromoted.recommended_fallback).toBe('none');
    expect(notPromoted.reasons).toEqual(['candidate_not_promoted']);

    const missingHandoff = await assessHistoricalValidity(harness.engine, { candidate_id: 'candidate-no-handoff', now: FIXED_NOW });
    expect(missingHandoff.decision).toBe('deny');
    expect(missingHandoff.recommended_fallback).toBe('none');
    expect(missingHandoff.reasons).toEqual(['candidate_missing_handoff']);
  } finally {
    await harness.cleanup();
  }
});

test('historical validity service denies superseded candidates as stale', async () => {
  const harness = await createHarness('superseded');

  try {
    await seedPromotedCandidate(harness.engine, {
      id: 'candidate-superseded-old',
      scope_id: 'workspace:default',
      reviewed_at: '2026-04-20T10:00:00.000Z',
    });
    await recordCanonicalHandoff(harness.engine, {
      candidate_id: 'candidate-superseded-old',
      reviewed_at: '2026-04-20T10:05:00.000Z',
    });

    await seedPromotedCandidate(harness.engine, {
      id: 'candidate-superseded-new',
      scope_id: 'workspace:default',
      reviewed_at: '2026-04-23T10:00:00.000Z',
    });
    await recordCanonicalHandoff(harness.engine, {
      candidate_id: 'candidate-superseded-new',
      reviewed_at: '2026-04-23T10:05:00.000Z',
    });

    await supersedeMemoryCandidateEntry(harness.engine, {
      superseded_candidate_id: 'candidate-superseded-old',
      replacement_candidate_id: 'candidate-superseded-new',
      review_reason: 'Newer promoted evidence replaced the older claim.',
    });

    const result = await assessHistoricalValidity(harness.engine, { candidate_id: 'candidate-superseded-old', now: FIXED_NOW });
    expect(result.decision).toBe('deny');
    expect(result.stale_claim).toBe(true);
    expect(result.recommended_fallback).toBe('supersede');
    expect(result.reasons).toEqual(['candidate_superseded']);
  } finally {
    await harness.cleanup();
  }
});

test('historical validity service rejects invalid now Date inputs with a controlled error', async () => {
  const harness = await createHarness('invalid-now');

  try {
    await seedPromotedCandidate(harness.engine, {
      id: 'candidate-invalid-now',
      scope_id: 'workspace:default',
      reviewed_at: '2026-04-23T10:00:00.000Z',
    });
    await recordCanonicalHandoff(harness.engine, {
      candidate_id: 'candidate-invalid-now',
      reviewed_at: '2026-04-23T10:05:00.000Z',
    });

    await expect(assessHistoricalValidity(harness.engine, {
      candidate_id: 'candidate-invalid-now',
      now: new Date('not-a-date'),
    })).rejects.toMatchObject({ code: 'invalid_status_transition' });
  } finally {
    await harness.cleanup();
  }
});

async function createHarness(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-historical-validity-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  return {
    engine,
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedPromotedCandidate(
  engine: SQLiteEngine,
  input: {
    id: string;
    scope_id: string;
    reviewed_at: string;
  },
) {
  await engine.createMemoryCandidateEntry({
    id: input.id,
    scope_id: input.scope_id,
    candidate_type: 'fact',
    proposed_content: `Historical validity candidate ${input.id}.`,
    source_refs: ['User, direct message, 2026-04-24 8:00 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.9,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/historical-validity',
    reviewed_at: null,
    review_reason: null,
  });
  await advanceMemoryCandidateStatus(engine, { id: input.id, next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, {
    id: input.id,
    next_status: 'staged_for_review',
    review_reason: 'Prepared for validity checks.',
  });
  await promoteMemoryCandidateEntry(engine, {
    id: input.id,
    reviewed_at: input.reviewed_at,
    review_reason: `Promoted ${input.id}.`,
  });
}

async function seedStagedCandidate(
  engine: SQLiteEngine,
  input: {
    id: string;
    scope_id: string;
  },
) {
  await engine.createMemoryCandidateEntry({
    id: input.id,
    scope_id: input.scope_id,
    candidate_type: 'fact',
    proposed_content: `Competing staged candidate ${input.id}.`,
    source_refs: ['User, direct message, 2026-04-24 8:10 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.75,
    importance_score: 0.6,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/historical-validity',
    reviewed_at: null,
    review_reason: null,
  });
  await advanceMemoryCandidateStatus(engine, { id: input.id, next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, {
    id: input.id,
    next_status: 'staged_for_review',
    review_reason: 'Competing candidate is under review.',
  });
}
