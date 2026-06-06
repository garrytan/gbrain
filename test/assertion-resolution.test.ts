import { describe, expect, test } from 'bun:test';
import {
  filterRetrievableAssertions,
  planRetrievableAssertions,
  resolveExtractedClaim,
} from '../src/core/assertions/assertion-resolution.ts';
import type { AssertionRecord, ExtractedClaim } from '../src/core/assertions/assertion-types.ts';

const NOW = '2026-05-20T12:00:00.000Z';

describe('assertion resolution lifecycle retrieval', () => {
  test('identical claims in different scopes create distinct assertions', () => {
    const workspace = resolveExtractedClaim({
      claim: claim({
        id: 'extracted-claim:runtime:workspace',
        value_json: { profile: 'managed' },
      }),
      scope_id: 'workspace:default',
      now: NOW,
    });

    const personal = resolveExtractedClaim({
      claim: claim({
        id: 'extracted-claim:runtime:personal',
        value_json: { profile: 'managed' },
      }),
      existing_assertions: [workspace.assertion],
      scope_id: 'personal:default',
      now: NOW,
    });

    expect(personal.resolution).toBe('created');
    expect(personal.assertion.scope_id).toBe('personal:default');
    expect(personal.assertion.id).not.toBe(workspace.assertion.id);
  });

  test('identical claims in the same scope remain duplicates', () => {
    const first = resolveExtractedClaim({
      claim: claim({
        id: 'extracted-claim:runtime:first',
        value_json: { profile: 'managed' },
      }),
      scope_id: 'workspace:default',
      now: NOW,
    });

    const duplicate = resolveExtractedClaim({
      claim: claim({
        id: 'extracted-claim:runtime:duplicate',
        value_json: { profile: 'managed' },
      }),
      existing_assertions: [first.assertion],
      scope_id: 'workspace:default',
      now: NOW,
    });

    expect(duplicate.resolution).toBe('duplicate');
    expect(duplicate.assertion.id).toBe(first.assertion.id);
    expect(duplicate.assertion.scope_id).toBe('workspace:default');
  });

  test('conflict set IDs include scope and stay stable within a scope', () => {
    const workspaceBase = assertion({
      id: 'assertion:workspace:base',
      value_json: { profile: 'managed' },
    });
    const workspaceConflict = resolveExtractedClaim({
      claim: claim({
        id: 'extracted-claim:workspace:conflict',
        value_json: { profile: 'local' },
      }),
      existing_assertions: [workspaceBase],
      scope_id: 'workspace:default',
      now: NOW,
    });
    const workspaceConflictAgain = resolveExtractedClaim({
      claim: claim({
        id: 'extracted-claim:workspace:conflict-again',
        value_json: { profile: 'hybrid' },
      }),
      existing_assertions: [workspaceBase],
      scope_id: 'workspace:default',
      now: NOW,
    });
    const personalBase = assertion({
      id: 'assertion:personal:base',
      scope_id: 'personal:default',
      value_json: { profile: 'managed' },
    });
    const personalConflict = resolveExtractedClaim({
      claim: claim({
        id: 'extracted-claim:personal:conflict',
        value_json: { profile: 'local' },
      }),
      existing_assertions: [personalBase],
      scope_id: 'personal:default',
      now: NOW,
    });

    const workspaceConflictSetId = workspaceConflict.assertion.conflict_set_id;
    const workspaceConflictAgainSetId = workspaceConflictAgain.assertion.conflict_set_id;
    const personalConflictSetId = personalConflict.assertion.conflict_set_id;
    if (!workspaceConflictSetId || !workspaceConflictAgainSetId || !personalConflictSetId) {
      throw new Error('expected conflict set ids');
    }

    expect(workspaceConflict.resolution).toBe('conflicted');
    expect(personalConflict.resolution).toBe('conflicted');
    expect(workspaceConflictSetId).toBe(workspaceConflictAgainSetId);
    expect(workspaceConflictSetId).not.toBe(personalConflictSetId);
    expect(workspaceConflict.conflict_sets[0]!.id).toBe(workspaceConflictSetId);
    expect(personalConflict.conflict_sets[0]!.id).toBe(personalConflictSetId);
  });

  test('temporal supersession expires the older assertion', () => {
    const oldAssertion = assertion({
      id: 'assertion:runtime:old',
      value_json: { profile: 'managed' },
      valid_from: '2026-05-20T09:00:00.000Z',
    });

    const result = resolveExtractedClaim({
      claim: claim({
        id: 'extracted-claim:runtime:new',
        value_json: { profile: 'managed_or_local_sqlite' },
        valid_from: '2026-05-20T10:00:00.000Z',
      }),
      existing_assertions: [oldAssertion],
      now: NOW,
    });

    expect(result.resolution).toBe('superseded');
    expect(result.updated_assertions).toEqual([
      expect.objectContaining({
        id: oldAssertion.id,
        lifecycle_state: 'expired',
        superseded_by_assertion_id: result.assertion.id,
      }),
    ]);
  });

  test('default retrieval marks stale canonical assertions verify-first and excludes expired archived purged', () => {
    const assertions = [
      assertion({ id: 'assertion:active', lifecycle_state: 'active', property: 'runtime.active' }),
      assertion({ id: 'assertion:stale', lifecycle_state: 'stale', property: 'runtime.stale', claim_type: 'code_claim' }),
      assertion({ id: 'assertion:expired', lifecycle_state: 'expired', property: 'runtime.expired' }),
      assertion({ id: 'assertion:archived', lifecycle_state: 'archived', property: 'runtime.archived' }),
      assertion({ id: 'assertion:purged', lifecycle_state: 'purged', property: 'runtime.purged' }),
      assertion({ id: 'assertion:candidate', authority_state: 'candidate', property: 'runtime.candidate' }),
    ];

    expect(planRetrievableAssertions(assertions).map((entry) => ({
      id: entry.assertion.id,
      activation: entry.activation,
      reason_codes: entry.reason_codes,
    }))).toEqual([
      {
        id: 'assertion:active',
        activation: 'answer_ground',
        reason_codes: ['canonical_active'],
      },
      {
        id: 'assertion:stale',
        activation: 'verify_first',
        reason_codes: ['canonical_stale', 'code_claim'],
      },
    ]);
    expect(filterRetrievableAssertions(assertions).map((entry) => entry.id)).toEqual([
      'assertion:active',
      'assertion:stale',
    ]);
  });

  test('requested candidates and rejected assertions do not bypass default lifecycle exclusion', () => {
    const assertions = [
      assertion({ id: 'assertion:candidate-active', authority_state: 'candidate', lifecycle_state: 'active' }),
      assertion({ id: 'assertion:candidate-expired', authority_state: 'candidate', lifecycle_state: 'expired' }),
      assertion({ id: 'assertion:rejected-active', authority_state: 'rejected', lifecycle_state: 'active' }),
      assertion({ id: 'assertion:rejected-archived', authority_state: 'rejected', lifecycle_state: 'archived' }),
    ];

    expect(planRetrievableAssertions(assertions, {
      include_candidates: true,
      include_rejected: true,
    }).map((entry) => ({
      id: entry.assertion.id,
      activation: entry.activation,
      reason_codes: entry.reason_codes,
    }))).toEqual([
      {
        id: 'assertion:candidate-active',
        activation: 'verify_first',
        reason_codes: ['candidate_requested'],
      },
      {
        id: 'assertion:rejected-active',
        activation: 'audit_only',
        reason_codes: ['rejected_audit'],
      },
    ]);
  });

  test('legacy retrieval filter keeps include_rejected on the default lifecycle path', () => {
    const assertions = [
      assertion({ id: 'assertion:canonical-active', lifecycle_state: 'active' }),
      assertion({ id: 'assertion:canonical-expired', lifecycle_state: 'expired' }),
      assertion({ id: 'assertion:canonical-archived', lifecycle_state: 'archived' }),
      assertion({ id: 'assertion:rejected-active', authority_state: 'rejected', lifecycle_state: 'active' }),
      assertion({ id: 'assertion:rejected-expired', authority_state: 'rejected', lifecycle_state: 'expired' }),
      assertion({ id: 'assertion:rejected-archived', authority_state: 'rejected', lifecycle_state: 'archived' }),
    ];

    expect(filterRetrievableAssertions(assertions, {
      include_rejected: true,
    }).map((entry) => entry.id)).toEqual([
      'assertion:canonical-active',
      'assertion:rejected-active',
    ]);
  });

  test('legacy retrieval filter keeps include_expired narrower than audit mode', () => {
    const assertions = [
      assertion({ id: 'assertion:canonical-active', lifecycle_state: 'active' }),
      assertion({ id: 'assertion:canonical-expired', lifecycle_state: 'expired' }),
      assertion({ id: 'assertion:canonical-archived', lifecycle_state: 'archived' }),
      assertion({ id: 'assertion:rejected-active', authority_state: 'rejected', lifecycle_state: 'active' }),
      assertion({ id: 'assertion:rejected-archived', authority_state: 'rejected', lifecycle_state: 'archived' }),
    ];

    expect(filterRetrievableAssertions(assertions, {
      include_expired: true,
    }).map((entry) => entry.id)).toEqual([
      'assertion:canonical-active',
      'assertion:canonical-expired',
    ]);
  });

  test('audit retrieval exposes expired archived conflicted and rejected assertions without purged content', () => {
    const assertions = [
      assertion({ id: 'assertion:expired', lifecycle_state: 'expired', property: 'runtime.expired' }),
      assertion({ id: 'assertion:archived', lifecycle_state: 'archived', property: 'runtime.archived' }),
      assertion({ id: 'assertion:conflicted', authority_state: 'conflicted', property: 'runtime.conflicted' }),
      assertion({ id: 'assertion:rejected', authority_state: 'rejected', property: 'runtime.rejected' }),
      assertion({ id: 'assertion:purged', lifecycle_state: 'purged', property: 'runtime.purged' }),
    ];

    expect(planRetrievableAssertions(assertions, { mode: 'audit' }).map((entry) => ({
      id: entry.assertion.id,
      activation: entry.activation,
      content_visible: entry.content_visible,
    }))).toEqual([
      { id: 'assertion:expired', activation: 'audit_only', content_visible: true },
      { id: 'assertion:archived', activation: 'audit_only', content_visible: true },
      { id: 'assertion:conflicted', activation: 'verify_first', content_visible: true },
      { id: 'assertion:rejected', activation: 'audit_only', content_visible: true },
      { id: 'assertion:purged', activation: 'audit_only', content_visible: false },
    ]);
    expect(planRetrievableAssertions(assertions, { mode: 'audit' })
      .find((entry) => entry.assertion.id === 'assertion:purged')?.assertion.normalized_claim)
      .toBe('[purged assertion content removed]');
  });
});

function assertion(input: {
  id: string;
  claim_type?: AssertionRecord['claim_type'];
  authority_state?: AssertionRecord['authority_state'];
  lifecycle_state?: AssertionRecord['lifecycle_state'];
  property?: string;
  value_json?: Record<string, unknown>;
  valid_from?: string | null;
  scope_id?: string;
}): AssertionRecord {
  return {
    id: input.id,
    scope_id: input.scope_id ?? 'workspace:default',
    policy_version: 'policy:v1',
    authority_scope: 'work',
    claim_type: input.claim_type ?? 'architecture_claim',
    target_type: 'system',
    target_id: 'systems/mbrain',
    target_slug: 'systems/mbrain',
    property: input.property ?? 'runtime.semantic_state',
    value_json: input.value_json ?? { source_of_truth: 'postgres' },
    normalized_claim: 'systems/mbrain runtime.semantic_state',
    authority_summary: {},
    confidence: 0.9,
    evidence_count: 1,
    authority_state: input.authority_state ?? 'canonical',
    lifecycle_state: input.lifecycle_state ?? 'active',
    valid_from: input.valid_from ?? null,
    valid_until: null,
    supersedes_assertion_id: null,
    superseded_by_assertion_id: null,
    conflict_set_id: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function claim(input: {
  id: string;
  value_json: Record<string, unknown>;
  valid_from?: string | null;
}): ExtractedClaim {
  return {
    id: input.id,
    source_id: 'source:codex-session',
    source_item_id: 'source-item:runtime',
    source_chunk_id: 'source-chunk:runtime:0',
    extractor_kind: 'llm_structured',
    extractor_version: 'assertion-extractor-v1',
    runner_job_id: null,
    claim_text: 'MBrain runtime profile changed.',
    claim_type: 'architecture_claim',
    target_hint: 'systems/mbrain',
    property_hint: 'runtime.semantic_state',
    value_json: input.value_json,
    confidence: 0.9,
    sensitivity_level: 'normal',
    prompt_injection_flag: false,
    secret_flag: false,
    status: 'pending_resolution',
    valid_from: input.valid_from ?? null,
    valid_until: null,
    created_at: NOW,
  };
}
