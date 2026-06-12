import { describe, expect, test } from 'bun:test';
import {
  buildInboxLeads,
  computeCandidateDebtMetrics,
} from '../src/core/services/inbox-lead-service.ts';
import type { MemoryCandidateEntry } from '../src/core/types.ts';

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
