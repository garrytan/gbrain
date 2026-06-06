import { describe, expect, test } from 'bun:test';
import { evaluateTrustContract } from '../src/core/services/trust-contract-service.ts';
import type { TrustContractDecision } from '../src/core/types/trust-contract.ts';

function expectPolicyMetadata(decision: TrustContractDecision): void {
  expect(decision.reason_codes.length).toBeGreaterThan(0);
  expect(decision.policy_version).toBe('trust-contract:v1');
  expect(decision.policy_version_hash).toMatch(/^[a-f0-9]{64}$/);
}

describe('trust contract service', () => {
  test('requires canonical reads before grounding stale compiled truth', () => {
    const decision = evaluateTrustContract({
      id: 'page:systems/mbrain',
      artifact_kind: 'compiled_truth',
      stale: true,
    });

    expect(decision).toMatchObject({
      artifact_id: 'page:systems/mbrain',
      activation: 'verify_first',
      activation_label: 'verify_first',
      authority: 'canonical_compiled_truth',
      freshness: 'stale',
      revalidation: 'read_canonical',
    });
    expect(decision.reason_codes).toContain('stale_compiled_truth');
    expectPolicyMetadata(decision);
  });

  test('requires code reverification for stale code-oriented artifacts', () => {
    const currentArtifact = evaluateTrustContract({
      id: 'file:src/core/operations.ts',
      artifact_kind: 'current_artifact',
      stale: true,
    });
    const codemapPointer = evaluateTrustContract({
      id: 'codemap:systems/mbrain#selectRetrievalRoute',
      artifact_kind: 'codemap_pointer',
      stale: true,
    });

    for (const decision of [currentArtifact, codemapPointer]) {
      expect(decision.activation).toBe('verify_first');
      expect(decision.freshness).toBe('stale');
      expect(decision.revalidation).toBe('reverify_code');
      expectPolicyMetadata(decision);
    }
  });

  test('ignores scope-denied profile memory until the scope gate allows it', () => {
    const decision = evaluateTrustContract({
      id: 'profile:secret',
      artifact_kind: 'profile_memory',
      scope_policy: 'deny',
    });

    expect(decision).toMatchObject({
      activation: 'ignore',
      activation_label: 'ignore',
      authority: 'scope_denied',
      revalidation: 'evaluate_scope_gate',
    });
    expect(decision.reason_codes).toContain('scope_policy_deny');
    expectPolicyMetadata(decision);
  });

  test('keeps targeted unreviewed candidates candidate-only with promote-first label', () => {
    const decision = evaluateTrustContract({
      id: 'candidate:direction',
      artifact_kind: 'memory_candidate',
      candidate_status: 'candidate',
      target_object_type: 'curated_note',
      source_refs_count: 2,
    });

    expect(decision).toMatchObject({
      activation: 'candidate_only',
      activation_label: 'promote_first',
      authority: 'unreviewed_candidate',
      freshness: 'not_applicable',
      revalidation: 'promote_candidate',
    });
    expectPolicyMetadata(decision);
  });

  test('keeps rejected and superseded candidates in the audit lane', () => {
    const decisions = ['rejected', 'superseded'] as const;

    for (const candidate_status of decisions) {
      const decision = evaluateTrustContract({
        id: `candidate:${candidate_status}`,
        artifact_kind: 'memory_candidate',
        candidate_status,
      });

      expect(decision.activation).toBe('candidate_only');
      expect(decision.activation_label).toBe('audit_only');
      expect(decision.revalidation).toBe('review_candidate');
      expectPolicyMetadata(decision);
    }
  });

  test('keeps source and timeline evidence citation-only', () => {
    const decisions = [
      evaluateTrustContract({ id: 'timeline:people/pedro:2026-04-01', artifact_kind: 'timeline' }),
      evaluateTrustContract({ id: 'source:meeting:1', artifact_kind: 'source_record' }),
    ];

    for (const decision of decisions) {
      expect(decision.activation).toBe('citation_only');
      expect(decision.activation_label).toBe('citation_only');
      expect(decision.authority).toBe('source_or_timeline_evidence');
      expectPolicyMetadata(decision);
    }
  });

  test('keeps context maps and graph paths orientation-only', () => {
    const decisions = [
      evaluateTrustContract({ id: 'map:workspace', artifact_kind: 'context_map' }),
      evaluateTrustContract({ id: 'graph:path:workspace', artifact_kind: 'graph_path' }),
    ];

    for (const decision of decisions) {
      expect(decision.activation).toBe('orientation_only');
      expect(decision.activation_label).toBe('orientation_only');
      expect(decision.authority).toBe('derived_orientation');
      expectPolicyMetadata(decision);
    }
  });

  test('grounds personal episodes only after explicit scope allow', () => {
    const missingScope = evaluateTrustContract({
      id: 'episode:planning',
      artifact_kind: 'personal_episode',
    });
    const allowed = evaluateTrustContract({
      id: 'episode:planning',
      artifact_kind: 'personal_episode',
      scope_policy: 'allow',
    });

    expect(missingScope).toMatchObject({
      activation: 'ignore',
      authority: 'scope_denied',
      revalidation: 'evaluate_scope_gate',
    });
    expect(missingScope.reason_codes).toContain('missing_scope_policy');
    expect(allowed).toMatchObject({
      activation: 'answer_ground',
      authority: 'personal_episode',
      revalidation: 'none',
    });
    expectPolicyMetadata(missingScope);
    expectPolicyMetadata(allowed);
  });

  test('grounds assertion surfaces only when scope lifecycle authority and freshness allow it', () => {
    const allowed = evaluateTrustContract({
      id: 'assertion:runtime-current',
      artifact_kind: 'assertion_surface',
      assertion: {
        scope_matches: true,
        lifecycle: 'active',
        authority: 'canonical',
      },
    });
    const stale = evaluateTrustContract({
      id: 'assertion:runtime-stale',
      artifact_kind: 'assertion_surface',
      stale: true,
      assertion: {
        scope_matches: true,
        lifecycle: 'active',
        authority: 'canonical',
        code_claim: true,
      },
    });
    const scopeMismatch = evaluateTrustContract({
      id: 'assertion:profile-other-scope',
      artifact_kind: 'assertion_surface',
      assertion: {
        scope_matches: false,
        lifecycle: 'active',
        authority: 'canonical',
      },
    });
    const missingScope = evaluateTrustContract({
      id: 'assertion:missing-scope',
      artifact_kind: 'assertion_surface',
      assertion: {
        lifecycle: 'active',
        authority: 'canonical',
      },
    });
    const missingLifecycle = evaluateTrustContract({
      id: 'assertion:missing-lifecycle',
      artifact_kind: 'assertion_surface',
      assertion: {
        scope_matches: true,
        authority: 'canonical',
      },
    });
    const nonCanonical = evaluateTrustContract({
      id: 'assertion:candidate',
      artifact_kind: 'assertion_surface',
      assertion: {
        scope_matches: true,
        lifecycle: 'active',
        authority: 'candidate',
      },
    });

    expect(allowed).toMatchObject({
      activation: 'answer_ground',
      authority: 'canonical_compiled_truth',
      freshness: 'current',
      revalidation: 'none',
    });
    expect(stale).toMatchObject({
      activation: 'verify_first',
      freshness: 'stale',
      revalidation: 'reverify_code',
    });
    expect(scopeMismatch).toMatchObject({
      activation: 'ignore',
      authority: 'scope_denied',
      revalidation: 'evaluate_scope_gate',
    });
    expect(missingScope).toMatchObject({
      activation: 'ignore',
      authority: 'scope_denied',
      revalidation: 'evaluate_scope_gate',
    });
    expect(missingScope.reason_codes).toContain('missing_scope_match');
    expect(missingLifecycle).toMatchObject({
      activation: 'verify_first',
      freshness: 'unknown',
      revalidation: 'read_canonical',
    });
    expect(missingLifecycle.reason_codes).toContain('missing_assertion_lifecycle');
    expect(nonCanonical).toMatchObject({
      activation: 'candidate_only',
      activation_label: 'audit_only',
      authority: 'unreviewed_candidate',
      revalidation: 'review_candidate',
    });
    for (const decision of [allowed, stale, scopeMismatch, missingScope, missingLifecycle, nonCanonical]) {
      expectPolicyMetadata(decision);
    }
  });
});
