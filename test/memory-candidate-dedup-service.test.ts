import { expect, test } from 'bun:test';
import type { MemoryCandidateEntry } from '../src/core/types.ts';
import { buildMemoryCandidateReviewBacklog } from '../src/core/services/memory-candidate-dedup-service.ts';

function makeCandidate(
  id: string,
  overrides: Partial<MemoryCandidateEntry> = {},
): MemoryCandidateEntry {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: 'Review the context map recommendation.',
    source_refs: ['User, direct message, 2026-04-23 12:00 PM KST'],
    generated_by: 'map_analysis',
    extraction_kind: 'inferred',
    confidence_score: 0.7,
    importance_score: 0.8,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/topic-1',
    reviewed_at: null,
    review_reason: null,
    verification_status: 'unverified',
    verification_method: null,
    verification_evidence: null,
    verification_source_refs: [],
    verified_at: null,
    created_at: new Date('2026-04-23T03:00:00.000Z'),
    updated_at: new Date('2026-04-23T04:00:00.000Z'),
    ...overrides,
  };
}

test('memory candidate dedup service groups exact duplicates and keeps the highest-priority representative', () => {
  const backlog = buildMemoryCandidateReviewBacklog([
    makeCandidate('duplicate-lower', {
      proposed_content: '  Review   the context map recommendation. ',
      confidence_score: 0.5,
      importance_score: 0.6,
      recurrence_score: 0.1,
      updated_at: new Date('2026-04-23T03:00:00.000Z'),
    }),
    makeCandidate('duplicate-higher', {
      proposed_content: 'review the context map recommendation.',
      confidence_score: 0.8,
      importance_score: 0.8,
      recurrence_score: 0.4,
      updated_at: new Date('2026-04-23T05:00:00.000Z'),
    }),
    makeCandidate('distinct-target', {
      target_object_id: 'concepts/topic-2',
      updated_at: new Date('2026-04-23T02:00:00.000Z'),
    }),
  ]);

  expect(backlog).toHaveLength(2);
  expect(backlog[0]?.representative_candidate.id).toBe('duplicate-higher');
  expect(backlog[0]?.grouped_candidate_ids).toEqual(['duplicate-higher', 'duplicate-lower']);
  expect(backlog[0]?.duplicate_count).toBe(2);
  expect(backlog[0]?.total_recurrence_score).toBeCloseTo(0.5, 6);
});

test('memory candidate dedup service is read-only against candidate inputs', () => {
  const candidate = makeCandidate('immutable');
  const before = {
    ...candidate,
    source_refs: [...candidate.source_refs],
    created_at: new Date(candidate.created_at),
    updated_at: new Date(candidate.updated_at),
  };

  const backlog = buildMemoryCandidateReviewBacklog([candidate]);

  expect(backlog[0]?.representative_candidate.id).toBe('immutable');
  expect(candidate).toEqual(before);
});
