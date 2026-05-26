import { describe, expect, test } from 'bun:test';
import {
  createAssertionEvidenceService,
  reResolveAssertionForSourceState,
  type AssertionEvidenceService,
} from '../src/core/assertions/assertion-evidence.ts';
import type {
  AssertionEvidenceRecord,
  AssertionEvidenceInput,
  AssertionRecord,
} from '../src/core/assertions/assertion-types.ts';

const NOW = '2026-05-20T12:00:00.000Z';

function createService(): AssertionEvidenceService {
  return createAssertionEvidenceService({
    now: () => NOW,
  });
}

describe('assertion evidence service', () => {
  test('multiple extracted claims can support one assertion through assertion_evidence', async () => {
    const service = createService();
    const assertion = await service.createAssertion(canonicalAssertion('assertion:runtime'));

    await service.linkEvidence(supportingEvidence({
      assertion_id: assertion.id,
      extracted_claim_id: 'extracted-claim:user-direct',
      source_id: 'source:user-direct',
      evidence_confidence: 1,
    }));
    await service.linkEvidence(supportingEvidence({
      assertion_id: assertion.id,
      extracted_claim_id: 'extracted-claim:codex-session',
      source_id: 'source:codex-session',
      evidence_confidence: 0.8,
    }));

    const summary = await service.recomputeAssertionEvidenceSummary(assertion.id);
    const evidence = await service.listAssertionEvidence(assertion.id);

    expect(evidence.map((entry) => entry.extracted_claim_id)).toEqual([
      'extracted-claim:user-direct',
      'extracted-claim:codex-session',
    ]);
    expect(summary).toMatchObject({
      assertion_id: assertion.id,
      evidence_count: 2,
      active_support_count: 2,
      active_contradiction_count: 0,
      authority_summary: 'supported_by_user_direct_and_session',
      confidence: 0.9,
    });
    expect(await service.getAssertion(assertion.id)).toMatchObject({
      evidence_count: 2,
      authority_summary: 'supported_by_user_direct_and_session',
      confidence: 0.9,
    });
  });

  test('source revocation re-resolves evidence summaries and keeps revoked evidence auditable', async () => {
    const service = createService();
    const assertion = await service.createAssertion(canonicalAssertion('assertion:runtime'));

    const directEvidence = await service.linkEvidence(supportingEvidence({
      assertion_id: assertion.id,
      extracted_claim_id: 'extracted-claim:user-direct',
      source_id: 'source:user-direct',
      evidence_confidence: 1,
    }));
    const sessionEvidence = await service.linkEvidence(supportingEvidence({
      assertion_id: assertion.id,
      extracted_claim_id: 'extracted-claim:codex-session',
      source_id: 'source:codex-session',
      evidence_confidence: 0.7,
    }));

    const revocation = await service.revokeSourceEvidence({
      source_id: 'source:user-direct',
      reason: 'source consent revoked',
      actor: 'user',
      revoked_at: '2026-05-20T12:30:00.000Z',
    });
    const summary = await service.recomputeAssertionEvidenceSummary(assertion.id);
    const evidence = await service.listAssertionEvidence(assertion.id, {
      include_revoked: true,
    });

    expect(revocation.affected_assertion_ids).toEqual([assertion.id]);
    expect(evidence.find((entry) => entry.id === directEvidence.id)).toMatchObject({
      revocation_state: 'revoked',
      valid_until: '2026-05-20T12:30:00.000Z',
    });
    expect(evidence.find((entry) => entry.id === sessionEvidence.id)).toMatchObject({
      revocation_state: 'active',
      valid_until: null,
    });
    expect(summary).toMatchObject({
      assertion_id: assertion.id,
      evidence_count: 1,
      revoked_evidence_count: 1,
      active_support_count: 1,
      authority_summary: 'supported_by_session_only',
      confidence: 0.7,
    });
    expect(summary.events.map((event) => event.event_type)).toContain('evidence_revoked');
    expect(summary.events.map((event) => event.event_type)).toContain('evidence_summary_recomputed');
  });

  test('contradicting evidence updates assertion authority without losing support lineage', async () => {
    const service = createService();
    const assertion = await service.createAssertion(canonicalAssertion('assertion:runtime'));

    await service.linkEvidence(supportingEvidence({
      assertion_id: assertion.id,
      extracted_claim_id: 'extracted-claim:postgres',
      source_id: 'source:user-direct',
      evidence_confidence: 0.95,
    }));
    await service.linkEvidence({
      ...supportingEvidence({
        assertion_id: assertion.id,
        extracted_claim_id: 'extracted-claim:markdown',
        source_id: 'source:markdown-import',
        evidence_confidence: 0.9,
      }),
      contribution_type: 'contradicts',
    });

    const summary = await service.recomputeAssertionEvidenceSummary(assertion.id);
    const evidence = await service.listAssertionEvidence(assertion.id);

    expect(summary).toMatchObject({
      assertion_id: assertion.id,
      evidence_count: 2,
      active_support_count: 1,
      active_contradiction_count: 1,
      authority_state: 'conflicted',
    });
    expect(evidence.map((entry) => entry.contribution_type)).toEqual(['supports', 'contradicts']);
  });

  test('source chunk purge re-resolves only affected assertion evidence', async () => {
    const assertion = canonicalAssertion('assertion:runtime');
    const retainedEvidence = storedEvidence(supportingEvidence({
        assertion_id: assertion.id,
        extracted_claim_id: 'extracted-claim:retained',
        source_id: 'source:codex-session',
        evidence_confidence: 0.9,
      }), {
      id: 'assertion-evidence:retained',
      forgetting_state: 'retained' as const,
      revocation_state: 'active' as const,
    });
    const purgedEvidence = storedEvidence(supportingEvidence({
        assertion_id: assertion.id,
        extracted_claim_id: 'extracted-claim:purged',
        source_id: 'source:codex-session',
        evidence_confidence: 0.7,
      }), {
      id: 'assertion-evidence:purged',
      source_chunk_id: 'source:codex-session:chunk:purged',
      forgetting_state: 'retained' as const,
      revocation_state: 'active' as const,
    });

    const result = reResolveAssertionForSourceState(assertion, [retainedEvidence, purgedEvidence], {
      purged_source_chunk_ids: ['source:codex-session:chunk:purged'],
    });

    expect(result.evidence.find((entry) => entry.id === 'assertion-evidence:purged')).toMatchObject({
      revocation_state: 'source_purged',
      forgetting_state: 'purged',
    });
    expect(result.evidence.find((entry) => entry.id === 'assertion-evidence:retained')).toMatchObject({
      revocation_state: 'active',
      forgetting_state: 'retained',
    });
    expect(result.assertion).toMatchObject({
      evidence_count: 1,
      confidence: 0.9,
    });
  });
});

function canonicalAssertion(id: string): AssertionRecord {
  return {
    id,
    claim_type: 'architecture_claim',
    target_type: 'system',
    target_id: null,
    target_slug: 'systems/mbrain',
    property: 'runtime.semantic_state',
    value_json: { source_of_truth: 'postgres' },
    normalized_claim: 'systems/mbrain runtime.semantic_state = postgres',
    authority_summary: 'seeded',
    confidence: 0,
    evidence_count: 0,
    authority_state: 'canonical',
    lifecycle_state: 'active',
    valid_from: null,
    valid_until: null,
    supersedes_assertion_id: null,
    superseded_by_assertion_id: null,
    conflict_set_id: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function supportingEvidence(input: {
  assertion_id: string;
  extracted_claim_id: string;
  source_id: string;
  evidence_confidence: number;
}): AssertionEvidenceInput {
  return {
    assertion_id: input.assertion_id,
    extracted_claim_id: input.extracted_claim_id,
    source_id: input.source_id,
    source_item_id: `${input.source_id}:item`,
    source_chunk_id: `${input.source_id}:chunk:0`,
    session_id: input.source_id === 'source:codex-session' ? 'session:codex' : null,
    task_event_id: input.source_id === 'source:codex-session' ? 'task-event:phase-03' : null,
    contribution_type: 'supports',
    evidence_authority: input.source_id === 'source:user-direct' ? 'user_direct' : 'session_derived',
    evidence_confidence: input.evidence_confidence,
    valid_from: NOW,
    valid_until: null,
  };
}

function storedEvidence(
  input: AssertionEvidenceInput,
  patch: Partial<AssertionEvidenceRecord> & Pick<AssertionEvidenceRecord, 'id'>,
): AssertionEvidenceRecord {
  return {
    id: patch.id,
    assertion_id: input.assertion_id,
    extracted_claim_id: input.extracted_claim_id,
    source_id: input.source_id,
    source_item_id: input.source_item_id,
    source_chunk_id: patch.source_chunk_id ?? input.source_chunk_id,
    session_id: input.session_id ?? null,
    task_event_id: input.task_event_id ?? null,
    contribution_type: input.contribution_type,
    evidence_authority: input.evidence_authority,
    evidence_confidence: input.evidence_confidence,
    valid_from: input.valid_from ?? null,
    valid_until: input.valid_until ?? null,
    revocation_state: patch.revocation_state ?? 'active',
    forgetting_state: patch.forgetting_state ?? 'retained',
    created_at: patch.created_at ?? NOW,
  };
}
