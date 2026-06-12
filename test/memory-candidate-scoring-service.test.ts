import { expect, test } from 'bun:test';
import type { MemoryCandidateEntry } from '../src/core/types.ts';
import {
  rankMemoryCandidateEntries,
  scoreMemoryCandidateEntry,
} from '../src/core/services/memory-candidate-scoring-service.ts';

function makeCandidate(
  id: string,
  overrides: Partial<MemoryCandidateEntry> = {},
): MemoryCandidateEntry {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: `Candidate ${id}`,
    source_refs: ['User, direct message, 2026-04-23 10:00 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.7,
    importance_score: 0.7,
    recurrence_score: 0.3,
    sensitivity: 'work',
    status: 'candidate',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/memory-candidate-scoring',
    reviewed_at: null,
    review_reason: null,
    verification_status: 'unverified',
    verification_method: null,
    verification_evidence: null,
    verification_source_refs: [],
    verified_at: null,
    created_at: new Date('2026-04-23T01:00:00.000Z'),
    updated_at: new Date('2026-04-23T02:00:00.000Z'),
    ...overrides,
  };
}

test('memory candidate scoring service derives source quality, effective confidence, and deterministic ranking', () => {
  const ranked = rankMemoryCandidateEntries([
    makeCandidate('candidate-c', {
      source_refs: [],
      extraction_kind: 'extracted',
      confidence_score: 1,
      importance_score: 1,
      recurrence_score: 1,
    }),
    makeCandidate('candidate-b', {
      source_refs: [
        'User, direct message, 2026-04-23 10:00 AM KST',
        'User, direct message, 2026-04-23 10:00 AM KST',
      ],
      confidence_score: 0.9,
      importance_score: 0.7,
      recurrence_score: 0.2,
    }),
    makeCandidate('candidate-a', {
      source_refs: [
        'User, direct message, 2026-04-23 10:00 AM KST',
        'Meeting notes "Inbox Sync", 2026-04-23 10:05 AM KST',
      ],
      confidence_score: 0.6,
      importance_score: 0.8,
      recurrence_score: 0.5,
    }),
  ]);

  expect(ranked.map((entry) => entry.candidate.id)).toEqual([
    'candidate-a',
    'candidate-b',
    'candidate-c',
  ]);

  expect(ranked[0].source_quality_score).toBe(1);
  expect(ranked[0].effective_confidence_score).toBe(0.6);
  expect(ranked[0].review_priority_score).toBeCloseTo(0.695, 6);

  expect(ranked[1].source_quality_score).toBe(0.6);
  expect(ranked[1].effective_confidence_score).toBe(0.6);
  expect(ranked[1].review_priority_score).toBeCloseTo(0.615, 6);

  expect(ranked[2].source_quality_score).toBe(0);
  expect(ranked[2].effective_confidence_score).toBe(0);
  expect(ranked[2].review_priority_score).toBeCloseTo(0.595, 6);
});

test('memory candidate scoring service breaks ties by newer updated_at then id', () => {
  const ranked = rankMemoryCandidateEntries([
    makeCandidate('candidate-c', {
      updated_at: new Date('2026-04-23T02:00:00.000Z'),
      confidence_score: 0.5,
      importance_score: 0.5,
      recurrence_score: 0.5,
      source_refs: ['A', 'B'],
    }),
    makeCandidate('candidate-a', {
      updated_at: new Date('2026-04-23T03:00:00.000Z'),
      confidence_score: 0.5,
      importance_score: 0.5,
      recurrence_score: 0.5,
      source_refs: ['A', 'B'],
    }),
    makeCandidate('candidate-b', {
      updated_at: new Date('2026-04-23T03:00:00.000Z'),
      confidence_score: 0.5,
      importance_score: 0.5,
      recurrence_score: 0.5,
      source_refs: ['A', 'B'],
    }),
  ]);

  expect(ranked.map((entry) => entry.candidate.id)).toEqual([
    'candidate-a',
    'candidate-b',
    'candidate-c',
  ]);
});

test('memory candidate scoring service sorts near ties by raw score before rounded display score', () => {
  const ranked = rankMemoryCandidateEntries([
    makeCandidate('candidate-newer-slightly-lower', {
      updated_at: new Date('2026-04-23T03:00:00.000Z'),
      confidence_score: 0.5,
      importance_score: 0.5,
      recurrence_score: 0.5,
      source_refs: ['A', 'B'],
    }),
    makeCandidate('candidate-older-slightly-higher', {
      updated_at: new Date('2026-04-23T02:00:00.000Z'),
      confidence_score: 0.5,
      importance_score: 0.500001,
      recurrence_score: 0.5,
      source_refs: ['A', 'B'],
    }),
  ]);

  expect(ranked[0].review_priority_score).toBe(ranked[1].review_priority_score);
  expect(ranked.map((entry) => entry.candidate.id)).toEqual([
    'candidate-older-slightly-higher',
    'candidate-newer-slightly-lower',
  ]);
});

test('memory candidate scoring service does not mutate candidate inputs', () => {
  const candidate = makeCandidate('candidate-read-only', {
    source_refs: ['User, direct message, 2026-04-23 10:00 AM KST'],
    confidence_score: 0.9,
  });
  const before = {
    ...candidate,
    source_refs: [...candidate.source_refs],
    created_at: new Date(candidate.created_at),
    updated_at: new Date(candidate.updated_at),
  };

  const scored = scoreMemoryCandidateEntry(candidate);

  expect(scored.candidate.id).toBe('candidate-read-only');
  expect(candidate).toEqual(before);
});
