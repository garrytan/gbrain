import { describe, expect, test } from 'bun:test';
import {
  buildCandidateSignals,
  selectCandidateSignalPolicy,
} from '../src/core/services/candidate-signal-service.ts';
import type {
  CanonicalHandoffEntry,
  CanonicalTargetProposalEntry,
  MemoryCandidateEntry,
  RetrievalSelector,
} from '../src/core/types.ts';

function makeCandidate(
  id: string,
  overrides: Partial<MemoryCandidateEntry> = {},
): MemoryCandidateEntry {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: `Candidate ${id} proposes a retrieval direction change.`,
    source_refs: ['Source: User, direct message, 2026-05-16 12:00 KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.7,
    importance_score: 0.7,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status: 'candidate',
    target_object_type: 'curated_note',
    target_object_id: 'systems/mbrain',
    reviewed_at: null,
    review_reason: null,
    verification_status: 'unverified',
    verification_method: null,
    verification_evidence: null,
    verification_source_refs: [],
    verified_at: null,
    created_at: new Date('2026-05-16T03:00:00.000Z'),
    updated_at: new Date('2026-05-16T03:00:00.000Z'),
    ...overrides,
  };
}

function makeHandoff(candidateId: string): CanonicalHandoffEntry {
  return {
    id: `handoff-${candidateId}`,
    scope_id: 'workspace:default',
    candidate_id: candidateId,
    target_object_type: 'curated_note',
    target_object_id: 'systems/mbrain',
    source_refs: ['Source: User, direct message, 2026-05-16 12:00 KST'],
    reviewed_at: new Date('2026-05-16T03:05:00.000Z'),
    review_reason: 'Canonical handoff recorded.',
    interaction_id: null,
    created_at: new Date('2026-05-16T03:05:00.000Z'),
    updated_at: new Date('2026-05-16T03:05:00.000Z'),
  };
}

function makeProposal(
  candidateId: string,
  overrides: Partial<CanonicalTargetProposalEntry> = {},
): CanonicalTargetProposalEntry {
  return {
    id: `proposal-${candidateId}`,
    scope_id: 'workspace:default',
    source_candidate_id: candidateId,
    linked_candidate_ids: [candidateId],
    status: 'proposed',
    status_reason: null,
    proposal_kind: 'system_page',
    target_object_type: 'curated_note',
    proposed_slug: 'systems/mbrain',
    proposed_title: 'MBrain',
    proposed_page_type: 'system',
    proposed_repo_path: null,
    confidence_score: 0.8,
    importance_score: 0.8,
    rationale: 'Proposal fixture.',
    filing_basis: {},
    source_refs: ['Source: proposal fixture'],
    candidate_snapshot: {},
    duplicate_review: {},
    slug_quality_warnings: [],
    approval_actor: null,
    approved_at: null,
    approval_reason: null,
    bound_candidate_ids: [],
    stub_patch_candidate_id: null,
    stub_patch_state: null,
    rejected_at: null,
    rejection_reason: null,
    superseded_by: null,
    created_at: new Date('2026-05-16T03:10:00.000Z'),
    updated_at: new Date('2026-05-16T03:10:00.000Z'),
    ...overrides,
  };
}

function fakeEngine(
  candidates: MemoryCandidateEntry[],
  handoffs: CanonicalHandoffEntry[] = [],
  proposals: CanonicalTargetProposalEntry[] = [],
) {
  return {
    listMemoryCandidateEntries: async (
      { scope_id, status }: { scope_id?: string; status?: MemoryCandidateEntry['status'] } = {},
    ) => candidates.filter(candidate =>
      (status === undefined || candidate.status === status)
      && (scope_id === undefined || candidate.scope_id === scope_id),
    ),
    listCanonicalHandoffEntries: async (
      { scope_id, candidate_id }: { scope_id?: string; candidate_id?: string } = {},
    ) => handoffs.filter(handoff =>
      (scope_id === undefined || handoff.scope_id === scope_id)
      && (candidate_id === undefined || handoff.candidate_id === candidate_id),
    ),
    listCanonicalTargetProposalEntries: async (
      { scope_id, source_candidate_id }: { scope_id?: string; source_candidate_id?: string } = {},
    ) => proposals.filter(proposal =>
      (scope_id === undefined || proposal.scope_id === scope_id)
      && (source_candidate_id === undefined || proposal.source_candidate_id === source_candidate_id),
    ),
  };
}

const requiredRead: RetrievalSelector = {
  kind: 'compiled_truth',
  scope_id: 'workspace:default',
  slug: 'systems/mbrain',
};

describe('candidate signal service policy', () => {
  test('selects normal policy for ordinary retrieval', () => {
    const policy = selectCandidateSignalPolicy({
      query: 'what does mbrain know about retrieval',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
    });

    expect(policy.mode).toBe('normal');
    expect(policy.reason_codes).toContain('default_agent_retrieval');
    expect(policy.included_count).toBe(0);
    expect(policy.suppressed_count).toBe(0);
  });

  test('selects expanded policy for direction and memory-inbox queries', () => {
    const policy = selectCandidateSignalPolicy({
      query: '최근 방향성이나 memory inbox 후보도 같이 봐줘',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
    });

    expect(policy.mode).toBe('expanded');
    expect(policy.reason_codes).toContain('candidate_intent_query');
  });

  test('selects strict policy for explicit canonical-only queries', () => {
    const policy = selectCandidateSignalPolicy({
      query: 'canonical only, verified source-grounded facts only',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
    });

    expect(policy.mode).toBe('strict');
    expect(policy.reason_codes).toContain('strict_canonical_requested');
  });

  test('selects audit policy for cleanup and rejection queries', () => {
    const policy = selectCandidateSignalPolicy({
      query: 'review rejected and superseded memory candidates',
      scenario: 'auto_accumulation',
      requested_scope: 'work',
    });

    expect(policy.mode).toBe('audit');
    expect(policy.reason_codes).toContain('candidate_audit_query');
  });

  test('strict policy suppresses content but counts matching candidates', async () => {
    const result = await buildCandidateSignals(fakeEngine([
      makeCandidate('candidate-strict', {
        proposed_content: 'Candidate strict signal mentions canonical only retrieval.',
      }),
    ]), {
      query: 'canonical only retrieval',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
      required_reads: [requiredRead],
      canonical_candidates: [],
      known_subjects: [],
      limit: 5,
    });

    expect(result.candidate_signal_policy.mode).toBe('strict');
    expect(result.candidate_signal_policy.included_count).toBe(0);
    expect(result.candidate_signal_policy.suppressed_count).toBe(1);
    expect(result.candidate_signals).toEqual([]);
  });
});

describe('candidate signal service ranking and hints', () => {
  test('normal retrieval excludes unrelated high-priority backlog candidates', async () => {
    const result = await buildCandidateSignals(fakeEngine([
      makeCandidate('candidate-unrelated', {
        proposed_content: 'Unrelated candidate has very high importance.',
        importance_score: 1,
        confidence_score: 1,
        recurrence_score: 1,
        target_object_id: 'systems/other',
      }),
      makeCandidate('promoted-unrelated', {
        status: 'promoted',
        proposed_content: 'Promoted candidate is pending handoff for a different subject.',
        target_object_id: 'systems/other-promoted',
      }),
      makeCandidate('candidate-same-target', {
        proposed_content: 'MBrain retrieval candidate signal points to direction changes.',
        importance_score: 0.4,
        confidence_score: 0.4,
        target_object_id: 'systems/mbrain',
      }),
    ]), {
      query: 'mbrain retrieval direction',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
      required_reads: [requiredRead],
      canonical_candidates: [],
      known_subjects: [],
      limit: 5,
    });

    expect(result.candidate_signals.map(signal => signal.candidate_id)).toEqual(['candidate-same-target']);
    expect(result.candidate_signals[0]!.score_reasons).toContain('same_target');
    expect(result.candidate_signals[0]!.relation_to_canonical).toBe('same_target');
  });

  test('normal retrieval hides rejected and superseded candidates', async () => {
    const result = await buildCandidateSignals(fakeEngine([
      makeCandidate('candidate-active', { status: 'candidate' }),
      makeCandidate('candidate-rejected', { status: 'rejected' }),
      makeCandidate('candidate-superseded', { status: 'superseded' }),
    ]), {
      query: 'retrieval direction',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
      required_reads: [requiredRead],
      canonical_candidates: [],
      known_subjects: [],
      limit: 5,
    });

    expect(result.candidate_signals.map(signal => signal.candidate_id)).toEqual(['candidate-active']);
  });

  test('audit retrieval includes rejected and superseded outcome summaries', async () => {
    const result = await buildCandidateSignals(fakeEngine([
      makeCandidate('candidate-rejected', {
        status: 'rejected',
        review_reason: 'missing source evidence',
      }),
      makeCandidate('candidate-superseded', {
        status: 'superseded',
        review_reason: 'canonical page now covers it',
      }),
    ]), {
      query: 'audit rejected and superseded memory candidates',
      scenario: 'auto_accumulation',
      requested_scope: 'work',
      required_reads: [requiredRead],
      canonical_candidates: [],
      known_subjects: [],
      limit: 5,
    });

    expect(result.candidate_signal_policy.mode).toBe('audit');
    expect(result.candidate_signals.map(signal => signal.candidate_id)).toEqual([
      'candidate-rejected',
      'candidate-superseded',
    ]);
    expect(result.candidate_signals.map(signal => signal.status)).toEqual([
      'rejected',
      'superseded',
    ]);
    expect(result.candidate_signals.every(signal => signal.disposition_hint === 'hide_from_default_retrieval')).toBe(true);
    expect(result.candidate_signals[0]!.summary).toContain('Rejected candidate candidate-rejected');
    expect(result.candidate_signals[0]!.summary).toContain('hidden from default retrieval');
    expect(result.candidate_signals[0]!.summary).toContain('missing source evidence');
    expect(result.candidate_signals[1]!.summary).toContain('Superseded candidate candidate-superseded');
    expect(result.candidate_signals[1]!.summary).toContain('hidden from default retrieval');
    expect(result.candidate_signals[1]!.summary).toContain('canonical page now covers it');
  });

  test('promotion hints are deterministic for common candidate states', async () => {
    const result = await buildCandidateSignals(fakeEngine([
      makeCandidate('missing-provenance', { source_refs: [] }),
      makeCandidate('missing-target', { target_object_id: null, target_object_type: null }),
      makeCandidate('staged', { status: 'staged_for_review' }),
      makeCandidate('promoted', { status: 'promoted' }),
      makeCandidate('promoted-handed-off', { status: 'promoted' }),
    ], [
      makeHandoff('promoted-handed-off'),
    ]), {
      query: 'retrieval direction',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
      required_reads: [requiredRead],
      canonical_candidates: [],
      known_subjects: [],
      limit: 10,
    });

    const hints = Object.fromEntries(result.candidate_signals.map(signal => [signal.candidate_id, signal.promotion_hint]));
    expect(hints['missing-provenance']).toBe('needs_provenance');
    expect(hints['missing-target']).toBe('needs_canonical_target_proposal');
    expect(hints.staged).toBe('consider_preflight');
    expect(hints.promoted).toBe('already_promoted_needs_handoff');
    expect(hints['promoted-handed-off']).toBe('handoff_ready_for_curated_update');
  });

  test('targetless candidates expose proposal-specific hints without becoming answer evidence', async () => {
    const result = await buildCandidateSignals(fakeEngine([
      makeCandidate('missing-target-without-proposal', {
        target_object_type: null,
        target_object_id: null,
        proposed_content: 'MBrain retrieval direction needs a canonical home.',
      }),
      makeCandidate('missing-target-with-proposal', {
        target_object_type: null,
        target_object_id: null,
        proposed_content: 'MBrain retrieval direction needs a canonical home.',
      }),
      makeCandidate('missing-target-with-approved-proposal', {
        target_object_type: null,
        target_object_id: null,
        proposed_content: 'MBrain retrieval direction has an approved canonical home.',
      }),
      makeCandidate('missing-target-with-patch-staged-proposal', {
        target_object_type: null,
        target_object_id: null,
        proposed_content: 'MBrain retrieval direction has a staged canonical binding patch.',
      }),
      makeCandidate('missing-target-with-blocked-proposal', {
        target_object_type: null,
        target_object_id: null,
        proposed_content: 'MBrain retrieval direction has no stable canonical subject yet.',
      }),
    ], [], [
      makeProposal('missing-target-with-proposal', {
        id: 'proposal:missing-target',
        status: 'proposed',
        proposed_slug: 'systems/mbrain-retrieval-direction',
      }),
      makeProposal('missing-target-with-approved-proposal', {
        id: 'proposal:approved-target',
        status: 'approved',
        proposed_slug: 'systems/mbrain-retrieval-direction-approved',
      }),
      makeProposal('missing-target-with-patch-staged-proposal', {
        id: 'proposal:patch-staged-target',
        status: 'patch_staged',
        proposed_slug: 'systems/mbrain-retrieval-direction-patch-staged',
      }),
      makeProposal('missing-target-with-blocked-proposal', {
        id: 'proposal:blocked-target',
        status: 'blocked',
        status_reason: 'unstable_subject_identity',
        proposed_slug: 'concepts/unstable-subject-identity',
      }),
    ]), {
      query: 'mbrain retrieval direction',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
      required_reads: [requiredRead],
      canonical_candidates: [],
      known_subjects: [],
      limit: 10,
    });

    expect(result.candidate_signals).toHaveLength(5);
    const signals = Object.fromEntries(result.candidate_signals.map(signal => [signal.candidate_id, signal]));

    expect(signals['missing-target-without-proposal']).toMatchObject({
      promotion_hint: 'needs_canonical_target_proposal',
      review_priority_hint: 'needs_canonical_target_proposal',
      activation: 'candidate_only',
      authority: 'unreviewed_candidate',
    });
    expect(signals['missing-target-without-proposal']!.promotion_hint).not.toBe('needs_target');

    expect(signals['missing-target-with-proposal']).toMatchObject({
      promotion_hint: 'approve_or_reject_canonical_target_proposal',
      review_priority_hint: 'approve_or_reject_canonical_target_proposal',
      activation: 'candidate_only',
      authority: 'unreviewed_candidate',
    });
    expect(signals['missing-target-with-proposal']!.promotion_hint).not.toBe('consider_preflight');
    expect(signals['missing-target-with-proposal']!.review_priority_hint).not.toBe('advance_to_review');
    expect(signals['missing-target-with-proposal']!.summary).toContain('proposal:missing-target');
    expect(signals['missing-target-with-proposal']!.summary).toContain('approve or reject');

    expect(signals['missing-target-with-approved-proposal']).toMatchObject({
      promotion_hint: 'complete_canonical_target_binding',
      review_priority_hint: 'complete_canonical_target_binding',
      activation: 'candidate_only',
      authority: 'unreviewed_candidate',
    });
    expect(signals['missing-target-with-patch-staged-proposal']).toMatchObject({
      promotion_hint: 'complete_canonical_target_binding',
      review_priority_hint: 'complete_canonical_target_binding',
      activation: 'candidate_only',
      authority: 'unreviewed_candidate',
    });
    expect(signals['missing-target-with-blocked-proposal']).toMatchObject({
      promotion_hint: 'no_action',
      review_priority_hint: 'no_priority',
      activation: 'candidate_only',
      authority: 'unreviewed_candidate',
    });
    expect(signals['missing-target-with-blocked-proposal']!.summary).toContain('blocked canonical target proposal');
    expect(signals['missing-target-with-blocked-proposal']!.summary).toContain('proposal:blocked-target');
    expect(signals['missing-target-with-blocked-proposal']!.promotion_hint).not.toBe('needs_canonical_target_proposal');
    expect(signals['missing-target-with-blocked-proposal']!.pressure_reasons).not.toContain('unresolved_exposed_candidate');
  });

  test('non-hard-blocked blocked proposals keep actionable signal hints', async () => {
    const result = await buildCandidateSignals(fakeEngine([
      makeCandidate('missing-target-with-duplicate-proposal', {
        target_object_type: null,
        target_object_id: null,
        proposed_content: 'MBrain retrieval direction may duplicate an existing canonical page.',
      }),
    ], [], [
      makeProposal('missing-target-with-duplicate-proposal', {
        id: 'proposal:likely-duplicate',
        status: 'blocked',
        status_reason: 'likely_duplicate',
        proposed_slug: 'systems/mbrain-duplicate',
      }),
    ]), {
      query: 'mbrain retrieval direction',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
      required_reads: [requiredRead],
      canonical_candidates: [],
      known_subjects: [],
      limit: 10,
    });

    expect(result.candidate_signals).toHaveLength(1);
    expect(result.candidate_signals[0]).toMatchObject({
      candidate_id: 'missing-target-with-duplicate-proposal',
      promotion_hint: 'inspect_candidate',
      review_priority_hint: 'inspect_candidate',
    });
    expect(result.candidate_signals[0]!.pressure_reasons).toContain('unresolved_exposed_candidate');
    expect(result.candidate_signals[0]!.summary).toContain('inspect proposal status before promotion');
  });

  test('personal, secret, and unknown-sensitivity candidates are suppressed in work retrieval', async () => {
    const result = await buildCandidateSignals(fakeEngine([
      makeCandidate('work-visible', { sensitivity: 'work' }),
      makeCandidate('personal-hidden', { sensitivity: 'personal' }),
      makeCandidate('secret-hidden', { sensitivity: 'secret' }),
      makeCandidate('unknown-hidden', { sensitivity: 'unknown' }),
    ]), {
      query: 'retrieval direction',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
      required_reads: [requiredRead],
      canonical_candidates: [],
      known_subjects: [],
      limit: 10,
    });

    expect(result.candidate_signals.map(signal => signal.candidate_id)).toEqual(['work-visible']);
    expect(result.candidate_signal_policy.suppressed_count).toBe(3);
  });

  test('audit retrieval can surface unknown sensitivity without exposing secret candidates', async () => {
    const result = await buildCandidateSignals(fakeEngine([
      makeCandidate('unknown-audit-visible', { scope_id: 'personal:default', sensitivity: 'unknown' }),
      makeCandidate('secret-audit-hidden', { scope_id: 'personal:default', sensitivity: 'secret' }),
    ]), {
      query: 'audit memory candidates',
      scenario: 'auto_accumulation',
      requested_scope: 'personal',
      required_reads: [requiredRead],
      canonical_candidates: [],
      known_subjects: [],
      limit: 10,
    });

    expect(result.candidate_signal_policy.mode).toBe('audit');
    expect(result.candidate_signals.map(signal => signal.candidate_id)).toEqual(['unknown-audit-visible']);
    expect(result.candidate_signal_policy.suppressed_count).toBe(1);
  });

  test('candidate pressure is review-priority metadata and never answer-ground authority', async () => {
    const result = await buildCandidateSignals(fakeEngine([
      makeCandidate('promoted-no-handoff', {
        status: 'promoted',
        source_refs: ['Source: User, direct message, 2026-05-16 12:00 KST'],
        recurrence_score: 1,
      }),
      makeCandidate('missing-provenance-pressure', {
        source_refs: [],
        confidence_score: 0.9,
        importance_score: 0.9,
      }),
      makeCandidate('below-recurrence-threshold', {
        recurrence_score: 0.79,
      }),
    ]), {
      query: 'retrieval direction',
      scenario: 'knowledge_qa',
      requested_scope: 'work',
      required_reads: [requiredRead],
      canonical_candidates: [],
      known_subjects: [],
      limit: 10,
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    const signals = Object.fromEntries(result.candidate_signals.map((signal) => [signal.candidate_id, signal]));
    expect(signals['promoted-no-handoff']!.activation).toBe('candidate_only');
    expect(signals['promoted-no-handoff']!.pressure_reasons).toContain('stale_promoted_without_handoff');
    expect(signals['promoted-no-handoff']!.pressure_reasons).toContain('high_recurrence');
    expect(signals['promoted-no-handoff']!.review_priority_hint).toBe('record_canonical_handoff');
    expect(signals['missing-provenance-pressure']!.pressure_reasons).toContain('missing_provenance');
    expect(signals['missing-provenance-pressure']!.review_priority_hint).toBe('reject_missing_provenance');
    expect(signals['below-recurrence-threshold']!.pressure_reasons).not.toContain('high_recurrence');
  });
});
