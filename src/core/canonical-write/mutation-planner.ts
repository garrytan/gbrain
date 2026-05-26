import type {
  CanonicalWritePolicyDecision,
  CanonicalWritePolicyInput,
  CanonicalWritePolicyResult,
} from './write-policy.ts';

export interface CanonicalMutationPlan {
  operations: string[];
  canonical_write_blocked: boolean;
}

export function buildMutationPlan(
  input: CanonicalWritePolicyInput,
  policy: CanonicalWritePolicyResult,
): CanonicalMutationPlan {
  if (policy.decision !== 'auto_canonical') {
    return { operations: [], canonical_write_blocked: true };
  }
  return {
    operations: [projectionOperationFor(input.claim.property)],
    canonical_write_blocked: false,
  };
}

export function projectionOperationFor(property: string): string {
  if (property === 'decision.timeline') return 'append_decision_timeline';
  return property.startsWith('compiled_truth.') ? 'upsert_compiled_truth' : 'upsert_projection';
}

export function blockedPolicyDecisions(): CanonicalWritePolicyDecision[] {
  return ['candidate', 'verify_first', 'conflict', 'reject', 'quarantine', 'no_write'];
}
