import { describe, expect, test } from 'bun:test';
import {
  readCandidateContext,
} from '../src/core/services/inbox-lead-service.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { MemoryCandidateEntry } from '../src/core/types.ts';

describe('read candidate context', () => {
  test('requires explicit purpose before exposing candidate content', () => {
    const result = readCandidateContext({
      candidate: candidate({ proposed_content: 'Candidate content.' }),
      requested_scope: 'work',
    });

    expect(result).toMatchObject({
      access: 'denied',
      content: null,
    });
    expect(result.reason_codes).toContain('purpose_required');
  });

  test('denies secret candidates by default', () => {
    const result = readCandidateContext({
      candidate: candidate({
        id: 'candidate:secret',
        sensitivity: 'secret',
        proposed_content: 'Secret candidate content.',
      }),
      purpose: 'review',
      requested_scope: 'work',
      audit_reason: 'reviewing candidate',
    });

    expect(result.access).toBe('denied');
    expect(result.content).toBeNull();
    expect(result.reason_codes).toContain('secret_candidate_denied');
    expect(result.candidate_governance_metadata).toMatchObject({
      answer_ground: false,
      target_binding: {
        state: 'redacted',
        handoff_present: false,
      },
    });
    expect(JSON.stringify(result.candidate_governance_metadata)).not.toContain('systems/mbrain');
    expect(JSON.stringify(result.candidate_governance_metadata)).not.toContain('curated_note');
  });

  test('requires personal or mixed scope plus audit reason for personal candidates', () => {
    const noScope = readCandidateContext({
      candidate: candidate({ sensitivity: 'personal' }),
      purpose: 'review',
      requested_scope: 'work',
      audit_reason: 'reviewing candidate',
    });
    const noReason = readCandidateContext({
      candidate: candidate({ sensitivity: 'personal' }),
      purpose: 'review',
      requested_scope: 'personal',
    });
    const allowed = readCandidateContext({
      candidate: candidate({
        id: 'candidate:personal',
        sensitivity: 'personal',
        proposed_content: 'Personal candidate content.',
      }),
      purpose: 'review',
      requested_scope: 'personal',
      audit_reason: 'explicit personal review',
    });

    expect(noScope.access).toBe('denied');
    expect(noScope.reason_codes).toContain('personal_scope_required');
    expect(noReason.access).toBe('denied');
    expect(noReason.reason_codes).toContain('audit_reason_required');
    expect(allowed).toMatchObject({
      access: 'allowed',
      content: 'Personal candidate content.',
      activation: 'candidate_only',
      activation_label: 'promote_first',
      authority: 'unreviewed_candidate',
    });
    expect(allowed.warnings).toContain('Candidate context is non-canonical; do not use as answer evidence.');
  });

  test('registers read_candidate_context as a non-mutating operation', async () => {
    const op = operationsByName.read_candidate_context;
    expect(op).toBeDefined();
    expect(op?.mutating).toBe(false);
    expect(op?.cliHints?.name).toBe('read-candidate-context');

    const result = await op!.handler({
      engine: {
        getMemoryCandidateEntry: async () => candidate({
          id: 'candidate:operation',
          proposed_content: 'Operation candidate content.',
        }),
      } as any,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate:operation',
      purpose: 'review',
      requested_scope: 'work',
    }) as ReturnType<typeof readCandidateContext>;

    expect(result).toMatchObject({
      access: 'allowed',
      candidate_id: 'candidate:operation',
      content: 'Operation candidate content.',
    });
    expect(result.warnings).toContain('Candidate context is non-canonical; do not use as answer evidence.');
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
