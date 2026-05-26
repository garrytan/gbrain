import type { CanonicalWritePolicyInput } from './write-policy.ts';

export function buildCandidateFallback(input: CanonicalWritePolicyInput) {
  return {
    status: 'pending_review',
    reason_codes: candidateReasonCodes(input),
    safe_value_json: safeValueJson(input),
    source_refs: [...input.source_refs],
  };
}

export function buildQuarantine(input: CanonicalWritePolicyInput) {
  return {
    reason: input.claim.prompt_injection_flag ? 'prompt_injection_flag' : 'secret_flag',
    source_id: input.claim.source_id ?? '',
    source_chunk_id: input.claim.source_chunk_id ?? '',
    canonical_write_blocked: true,
    safe_value_json: safeValueJson(input),
  };
}

function candidateReasonCodes(input: CanonicalWritePolicyInput): string[] {
  const reasons: string[] = [];
  if (input.claim.source_kind !== 'user_direct') reasons.push('source_not_authoritative_for_auto_write');
  if (input.claim.claim_type.startsWith('inferred')) reasons.push('claim_is_inferred');
  if ((input.claim.target_certainty ?? 'exact') !== 'exact') reasons.push('target_not_exact');
  if (['personal', 'sensitive', 'secret'].includes(input.claim.sensitivity)) reasons.push('personal_sensitivity_requires_review');
  if (!['trusted_interactive', 'trusted_automation'].includes(input.runner_trust)) {
    reasons.push('runner_not_trusted_for_auto_write');
  }
  return reasons;
}

function safeValueJson(input: CanonicalWritePolicyInput): unknown {
  if (input.claim.secret_flag) return '[REDACTED_SECRET]';
  return redactLikelySecrets(input.claim.value_json);
}

function redactLikelySecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith('sk-') ? '[REDACTED_SECRET]' : value;
  if (Array.isArray(value)) return value.map(redactLikelySecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, redactLikelySecrets(nested)]),
    );
  }
  return value;
}
