import { describe, expect, test } from 'bun:test';
import {
  buildInboxLeads,
  computeCandidateDebtMetrics,
  readCandidateContext,
} from '../src/core/services/inbox-lead-service.ts';
import type { CanonicalTargetProposalEntry, MemoryCandidateEntry } from '../src/core/types.ts';

describe('inbox lead service', () => {
  test('builds content-light leads without proposed content', () => {
    const result = buildInboxLeads({
      candidates: [
        candidate({ id: 'candidate:1', proposed_content: 'Sensitive candidate content should not leak.' }),
      ],
      now: '2026-06-06T00:00:00.000Z',
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]).toMatchObject({
      candidate_id: 'candidate:1',
      status: 'candidate',
      activation: 'candidate_only',
      source_refs_count: 1,
      content_visibility: 'gated',
      candidate_governance_metadata: {
        answer_ground: false,
        why_not_answer_ground: expect.arrayContaining(['memory_inbox_candidate_is_non_canonical']),
        target_binding: {
          state: 'bound',
          handoff_present: false,
        },
      },
    });
    expect(JSON.stringify(result.leads[0])).not.toContain('Sensitive candidate content');
    expect(JSON.stringify(result)).not.toContain('proposed_content');
  });

  test('hides secret candidates from default leads and keeps terminal candidates audit-only', () => {
    const result = buildInboxLeads({
      candidates: [
        candidate({ id: 'candidate:secret', sensitivity: 'secret' }),
        candidate({ id: 'candidate:rejected', status: 'rejected', review_reason: 'duplicate' }),
        candidate({ id: 'candidate:superseded', status: 'superseded', review_reason: 'newer candidate exists' }),
      ],
      now: '2026-06-06T00:00:00.000Z',
    });

    expect(result.leads.map((lead) => lead.candidate_id)).toEqual([
      'candidate:rejected',
      'candidate:superseded',
    ]);
    expect(result.leads.every((lead) => lead.activation_label === 'audit_only')).toBe(true);
    expect(result.suppressed_count).toBe(1);
    expect(result.suppression_reason_codes).toContain('secret_candidate_hidden');
    expect(JSON.stringify(result)).not.toContain('candidate:secret');
  });

  test('marks promoted candidates without handoff as review pressure leads', () => {
    const result = buildInboxLeads({
      candidates: [
        candidate({ id: 'candidate:promoted', status: 'promoted' }),
      ],
      canonical_handoff_candidate_ids: [],
      now: '2026-06-06T00:00:00.000Z',
    });

    expect(result.leads[0]).toMatchObject({
      candidate_id: 'candidate:promoted',
      promotion_hint: 'already_promoted_needs_handoff',
      review_priority_hint: 'record_canonical_handoff',
    });
    expect(result.leads[0].pressure_reasons).toContain('stale_promoted_without_handoff');
  });

  test('computes deterministic candidate debt and review latency metrics', () => {
    const metrics = computeCandidateDebtMetrics({
      candidates: [
        candidate({
          id: 'candidate:missing-provenance',
          source_refs: [],
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        }),
        candidate({
          id: 'candidate:promoted',
          status: 'promoted',
          created_at: new Date('2026-06-02T00:00:00.000Z'),
          reviewed_at: new Date('2026-06-04T00:00:00.000Z'),
        }),
        candidate({
          id: 'candidate:rejected',
          status: 'rejected',
          created_at: new Date('2026-06-03T00:00:00.000Z'),
          reviewed_at: new Date('2026-06-05T00:00:00.000Z'),
        }),
      ],
      canonical_handoff_candidate_ids: [],
      now: '2026-06-06T00:00:00.000Z',
    });

    expect(metrics).toMatchObject({
      visible_candidate_count: 3,
      missing_provenance_count: 1,
      stale_promoted_without_handoff_count: 1,
      unresolved_exposed_count: 1,
      median_review_latency_ms: 172800000,
    });
  });

  test('does not count unstable-subject blocked proposals as unresolved exposed debt', () => {
    const metrics = computeCandidateDebtMetrics({
      candidates: [
        candidate({
          id: 'candidate:blocked',
          status: 'captured',
          target_object_type: null,
          target_object_id: null,
        }),
      ],
      canonical_target_proposals: [
        proposal({
          id: 'proposal:blocked',
          source_candidate_id: 'candidate:blocked',
          linked_candidate_ids: ['candidate:blocked'],
          status: 'blocked',
          status_reason: 'unstable_subject_identity',
        }),
      ],
      canonical_handoff_candidate_ids: [],
      now: '2026-06-06T00:00:00.000Z',
    });

    expect(metrics).toMatchObject({
      visible_candidate_count: 1,
      unresolved_exposed_count: 0,
      hard_blocked_by_proposal_count: 1,
    });
  });

  test('candidate context reads explicitly remain non-answer-ground even when allowed', () => {
    const result = readCandidateContext({
      candidate: candidate({
        id: 'candidate:allowed-context',
        proposed_content: 'Allowed candidate context remains non-canonical.',
      }),
      purpose: 'review',
      requested_scope: 'work',
    });

    expect(result).toMatchObject({
      candidate_id: 'candidate:allowed-context',
      access: 'allowed',
      activation: 'candidate_only',
      authority: 'unreviewed_candidate',
      candidate_governance_metadata: {
        answer_ground: false,
        why_not_answer_ground: expect.arrayContaining([
          'candidate_context_is_non_canonical',
          'candidate_context_requires_promotion_or_canonical_handoff',
        ]),
        verification: {
          status: 'unverified',
          method: null,
          source_refs_count: 0,
          verified_at_present: false,
        },
      },
    });
    expect(result.content).toContain('Allowed candidate context');
  });
});

function candidate(overrides: Partial<MemoryCandidateEntry>): MemoryCandidateEntry {
  return {
    id: 'candidate:base',
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: 'Candidate content.',
    source_refs: ['source:1'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.5,
    recurrence_score: 0,
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
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function proposal(overrides: Partial<CanonicalTargetProposalEntry>): CanonicalTargetProposalEntry {
  return {
    id: 'proposal:base',
    scope_id: 'workspace:default',
    source_candidate_id: 'candidate:base',
    linked_candidate_ids: [],
    status: 'proposed',
    status_reason: null,
    proposal_kind: 'concept_page',
    target_object_type: 'curated_note',
    proposed_slug: 'concepts/example',
    proposed_title: 'Example',
    proposed_page_type: 'concept',
    proposed_repo_path: null,
    confidence_score: 0.5,
    importance_score: 0.5,
    rationale: 'Example proposal.',
    filing_basis: {},
    source_refs: ['source:1'],
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
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}
