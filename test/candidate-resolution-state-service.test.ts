import { describe, expect, test } from 'bun:test';
import { classifyCandidateResolutionState } from '../src/core/services/candidate-resolution-state-service.ts';

const baseCandidate = {
  id: 'candidate:1',
  status: 'captured',
  sensitivity: 'work',
  source_refs: ['source:1'],
  target_object_id: null,
};

describe('candidate resolution state service', () => {
  test('classifies unstable-subject blocked proposals as hard blocked instead of unresolved', () => {
    const result = classifyCandidateResolutionState({
      candidate: baseCandidate,
      has_canonical_handoff: false,
      canonical_target_proposal: {
        id: 'proposal:1',
        status: 'blocked',
        status_reason: 'unstable_subject_identity',
      },
    });

    expect(result.state).toBe('hard_blocked_by_proposal');
    expect(result.counts_as_unresolved_exposed).toBe(false);
    expect(result.pressure_reasons).not.toContain('unresolved_exposed_candidate');
  });

  test('keeps targetless candidates without proposals unresolved', () => {
    const result = classifyCandidateResolutionState({
      candidate: baseCandidate,
      has_canonical_handoff: false,
      canonical_target_proposal: null,
    });

    expect(result.state).toBe('actionable_unresolved');
    expect(result.counts_as_unresolved_exposed).toBe(true);
    expect(result.pressure_reasons).toContain('unresolved_exposed_candidate');
  });

  test('keeps promoted candidates without handoff in handoff pressure', () => {
    const result = classifyCandidateResolutionState({
      candidate: { ...baseCandidate, status: 'promoted' },
      has_canonical_handoff: false,
      canonical_target_proposal: null,
    });

    expect(result.state).toBe('promoted_without_handoff');
    expect(result.counts_as_unresolved_exposed).toBe(false);
    expect(result.counts_as_promoted_without_handoff).toBe(true);
    expect(result.pressure_reasons).toContain('stale_promoted_without_handoff');
  });

  test('classifies proposed canonical target proposals as proposal pending', () => {
    const result = classifyCandidateResolutionState({
      candidate: baseCandidate,
      has_canonical_handoff: false,
      canonical_target_proposal: {
        id: 'proposal:2',
        status: 'proposed',
        status_reason: null,
      },
    });

    expect(result.state).toBe('proposal_pending');
    expect(result.counts_as_unresolved_exposed).toBe(false);
    expect(result.pressure_reasons).toContain('canonical_target_proposal_pending');
  });
});
