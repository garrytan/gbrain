import { describe, expect, test } from 'bun:test';
import type { MemoryCandidateEntry } from '../src/core/types.ts';
import { buildAgentSessionMaintenanceReview } from '../src/core/services/agent-session-maintenance-service.ts';

function candidate(input: Partial<MemoryCandidateEntry> & { id: string; proposed_content: string }): MemoryCandidateEntry {
  const now = new Date('2026-06-04T01:00:00.000Z');
  return {
    id: input.id,
    scope_id: input.scope_id ?? 'personal:default',
    candidate_type: input.candidate_type ?? 'profile_update',
    target_object_type: input.target_object_type ?? 'profile_memory',
    target_object_id: input.target_object_id ?? null,
    proposed_content: input.proposed_content,
    source_refs: input.source_refs ?? ['source_item:1', 'source_chunk:1'],
    extraction_kind: input.extraction_kind ?? 'inferred',
    sensitivity: input.sensitivity ?? 'personal',
    confidence_score: input.confidence_score ?? 0.7,
    importance_score: input.importance_score ?? 0.7,
    recurrence_score: input.recurrence_score ?? 0,
    generated_by: input.generated_by ?? 'agent',
    status: input.status ?? 'candidate',
    reviewed_at: input.reviewed_at ?? null,
    review_reason: input.review_reason ?? null,
    verification_status: 'unverified',
    verification_method: null,
    verification_evidence: null,
    verification_source_refs: [],
    verified_at: null,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
  };
}

describe('agent session maintenance review', () => {
  test('groups repeated session candidates without turning recurrence into truth', () => {
    const review = buildAgentSessionMaintenanceReview([
      candidate({
        id: 'candidate:1',
        proposed_content: 'The user prefers concise implementation checkpoints.',
        recurrence_score: 0.2,
      }),
      candidate({
        id: 'candidate:2',
        proposed_content: 'The user prefers concise implementation checkpoints.',
        recurrence_score: 0.4,
      }),
    ]);

    expect(review.groups).toHaveLength(1);
    expect(review.groups[0]).toMatchObject({
      duplicate_count: 2,
      total_recurrence_score: 0.6,
    });
    expect(review.groups[0]?.grouped_candidate_ids.sort()).toEqual(['candidate:1', 'candidate:2']);
    expect(review.authority_warning).toBe('recurrence_increases_review_priority_not_truth');
    expect(review.auto_promote_handoff_candidates).toHaveLength(0);
  });

  test('marks low-risk source-backed extracted candidates as auto-promote handoff inputs', () => {
    const review = buildAgentSessionMaintenanceReview([
      candidate({
        id: 'candidate:eligible',
        proposed_content: 'Decision: keep agent session compression deterministic.',
        candidate_type: 'note_update',
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        scope_id: 'workspace:default',
        sensitivity: 'work',
        extraction_kind: 'extracted',
        confidence_score: 0.95,
        importance_score: 0.8,
        recurrence_score: 0.2,
      }),
    ]);

    expect(review.auto_promote_handoff_candidates).toEqual(['candidate:eligible']);
  });
});
