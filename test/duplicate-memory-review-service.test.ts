import { expect, test } from 'bun:test';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import {
  reviewDuplicateMemory,
  summarizeDuplicateReviewForPreflight,
} from '../src/core/services/duplicate-memory-review-service.ts';
import type { MemoryCandidateEntry } from '../src/core/types.ts';

async function createEngine(): Promise<SQLiteEngine> {
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: ':memory:' });
  await engine.initSchema();
  return engine;
}

function makeCandidate(
  id: string,
  overrides: Partial<MemoryCandidateEntry> = {},
): MemoryCandidateEntry {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: 'Acme migration plan uses staged cutover with rollback notes.',
    source_refs: ['User, direct message, 2026-05-09 09:00 KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'staged_for_review',
    target_object_type: 'curated_note',
    target_object_id: 'projects/acme-migration',
    reviewed_at: null,
    review_reason: null,
    created_at: new Date('2026-05-09T00:00:00.000Z'),
    updated_at: new Date('2026-05-09T00:00:00.000Z'),
    ...overrides,
  };
}

test('duplicate review returns a likely duplicate for a near matching canonical page', async () => {
  const engine = await createEngine();
  await engine.putPage('projects/acme-migration', {
    type: 'project',
    title: 'Acme Migration',
    compiled_truth: 'The Acme migration plan uses staged cutover with rollback notes and operator checkpoints.',
  });
  await engine.addTag('projects/acme-migration', 'migration');
  await engine.addTag('projects/acme-migration', 'acme');

  const result = await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'proposed_memory',
    title: 'Acme migration plan',
    content: 'Acme migration plan uses staged cutover with rollback notes.',
    tags: ['migration', 'acme'],
    source_refs: ['User, direct message, 2026-05-09 09:00 KST'],
    include_pages: true,
    include_candidates: false,
    limit: 5,
  });

  expect(result.decision).toBe('likely_duplicate');
  expect(result.matches[0]?.kind).toBe('page');
  expect(result.matches[0]?.id).toBe('projects/acme-migration');
  expect(result.matches[0]?.score).toBeGreaterThanOrEqual(result.thresholds.likely_duplicate);
  expect(result.summary_lines[0]).toContain('likely_duplicate');
});

test('duplicate review reports same target update for a candidate with the same target object', async () => {
  const engine = await createEngine();
  await engine.createMemoryCandidateEntry(makeCandidate('existing-candidate', {
    proposed_content: 'Acme migration has a staged cutover and a rollback owner.',
    target_object_id: 'projects/acme-migration',
  }));

  const result = await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'memory_candidate',
    subject_id: 'incoming-candidate',
    content: 'Acme migration should update the staged cutover notes.',
    candidate_type: 'note_update',
    target_object_type: 'curated_note',
    target_object_id: 'projects/acme-migration',
    include_pages: false,
    include_candidates: true,
    limit: 5,
  });

  expect(result.decision).toBe('same_target_update');
  expect(result.matches[0]?.id).toBe('existing-candidate');
  expect(result.matches[0]?.reasons).toContain('same target object');
});

test('duplicate review excludes the subject candidate id', async () => {
  const engine = await createEngine();
  await engine.createMemoryCandidateEntry(makeCandidate('self-candidate'));

  const result = await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'memory_candidate',
    subject_id: 'self-candidate',
    content: 'Acme migration plan uses staged cutover with rollback notes.',
    candidate_type: 'note_update',
    target_object_type: 'curated_note',
    target_object_id: 'projects/acme-migration',
    include_pages: false,
    include_candidates: true,
    limit: 5,
  });

  expect(result.decision).toBe('no_match');
  expect(result.matches).toEqual([]);
});

test('duplicate review returns no match for unrelated memory', async () => {
  const engine = await createEngine();
  await engine.putPage('concepts/coffee', {
    type: 'concept',
    title: 'Coffee',
    compiled_truth: 'Coffee notes cover brew temperature and grinder calibration.',
  });

  const result = await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'proposed_memory',
    content: 'Deployment checklist requires release owner approval and rollback verification.',
    include_pages: true,
    include_candidates: true,
    limit: 5,
  });

  expect(result.decision).toBe('no_match');
  expect(result.matches).toEqual([]);
});

test('duplicate review does not mutate candidate inputs', async () => {
  const engine = await createEngine();
  const candidate = makeCandidate('immutable-candidate');
  await engine.createMemoryCandidateEntry(candidate);

  const before = await engine.getMemoryCandidateEntry('immutable-candidate');
  await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'proposed_memory',
    content: 'Acme migration plan uses staged cutover with rollback notes.',
    include_pages: false,
    include_candidates: true,
    limit: 5,
  });
  const after = await engine.getMemoryCandidateEntry('immutable-candidate');

  expect(after).toEqual(before);
});

test('preflight summary keeps only compact duplicate fields', async () => {
  const summary = summarizeDuplicateReviewForPreflight({
    decision: 'likely_duplicate',
    summary_lines: ['Duplicate review decision: likely_duplicate.'],
    thresholds: { possible_duplicate: 0.45, likely_duplicate: 0.72, same_target_update: 0.35 },
    matches: [
      {
        kind: 'page',
        id: 'projects/acme-migration',
        title: 'Acme Migration',
        score: 0.9,
        reasons: ['content overlap'],
      },
    ],
  });

  expect(summary).toEqual({
    decision: 'likely_duplicate',
    top_match: {
      kind: 'page',
      id: 'projects/acme-migration',
      score: 0.9,
      reasons: ['content overlap'],
    },
  });
});
