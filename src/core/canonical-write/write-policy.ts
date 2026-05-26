import { createHash } from 'crypto';

export type CanonicalWritePolicyDecision =
  | 'auto_canonical'
  | 'candidate'
  | 'verify_first'
  | 'conflict'
  | 'reject'
  | 'quarantine'
  | 'no_write';

export interface CanonicalWritePolicyClaim {
  id: string;
  source_kind: string;
  source_id?: string;
  source_item_id?: string;
  source_chunk_id?: string;
  claim_type: string;
  target_certainty?: string;
  target_type: string;
  target_id: string;
  target_slug: string;
  property: string;
  value_json: unknown;
  confidence: number;
  sensitivity: string;
  prompt_injection_flag: boolean;
  secret_flag: boolean;
  valid_from?: string | null;
  valid_until?: string | null;
}

export interface CanonicalWritePolicyInput {
  claim: CanonicalWritePolicyClaim;
  source_refs: string[];
  conflict_state: { kind?: string; existing_assertion_ids?: string[]; conflict_set_id?: string | null } | Record<string, unknown>;
  assertion_state: string;
  user_override_policy: string;
  session_write_grant: {
    session_id?: string;
    realm?: string;
    target_scope?: string;
    allowed_policy_outcomes: string[];
    revoked_at?: string | null;
    expires_at?: string | null;
  };
  realm: string;
  runner_trust: string;
  session_id?: string;
  evaluated_at?: string;
}

export interface CanonicalWritePolicyResult {
  decision: CanonicalWritePolicyDecision;
  explanation: string;
  explanation_hash?: string;
}

export function decideCanonicalWritePolicy(input: CanonicalWritePolicyInput): CanonicalWritePolicyResult {
  const decision = canonicalPolicyDecision(input);
  return {
    decision,
    explanation: policyExplanation(input, decision),
    explanation_hash: `sha256:${sha256(policyExplanation(input, decision))}`,
  };
}

export function explainCanonicalWritePolicy(input: CanonicalWritePolicyInput): CanonicalWritePolicyResult {
  return decideCanonicalWritePolicy(input);
}

function canonicalPolicyDecision(input: CanonicalWritePolicyInput): CanonicalWritePolicyDecision {
  if (input.claim.prompt_injection_flag) return 'quarantine';
  if (input.claim.secret_flag) return 'quarantine';
  if (input.user_override_policy === 'reject') return 'reject';
  if (!isGrantActive(input)) return 'no_write';
  if (conflictKind(input) !== 'none') return grantAllows(input, 'conflict') ? 'conflict' : 'no_write';
  if (input.claim.claim_type === 'code_claim' || input.claim.source_kind === 'code_repo') {
    return grantAllows(input, 'verify_first') ? 'verify_first' : 'no_write';
  }
  if (
    input.claim.source_kind === 'user_direct'
    && targetCertainty(input) === 'exact'
    && input.claim.confidence >= 0.9
    && input.assertion_state === 'canonical'
    && runnerCanAutoWrite(input)
    && grantAllows(input, 'auto_canonical')
  ) return 'auto_canonical';
  if (grantAllows(input, 'candidate')) return 'candidate';
  return 'no_write';
}

function policyExplanation(input: CanonicalWritePolicyInput, decision: CanonicalWritePolicyDecision): string {
  return [
    `source=${input.claim.source_kind}`,
    `claim=${input.claim.claim_type}`,
    `target=${targetCertainty(input)}`,
    `confidence=${input.claim.confidence}`,
    `sensitivity=${input.claim.sensitivity}`,
    `safety=${input.claim.prompt_injection_flag ? 'prompt_injection' : input.claim.secret_flag ? 'secret' : 'clear'}`,
    `conflict=${conflictKind(input)}`,
    `assertion=${input.assertion_state}`,
    `grant=${grantState(input)}`,
    `runner=${input.runner_trust}`,
    `=> ${decision}`,
  ].join(' ');
}

function targetCertainty(input: CanonicalWritePolicyInput): string {
  return input.claim.target_certainty ?? 'exact';
}

function conflictKind(input: CanonicalWritePolicyInput): string {
  return typeof input.conflict_state.kind === 'string' ? input.conflict_state.kind : 'none';
}

function isGrantActive(input: CanonicalWritePolicyInput): boolean {
  return grantState(input) === 'allowed';
}

function grantAllows(input: CanonicalWritePolicyInput, outcome: CanonicalWritePolicyDecision): boolean {
  return isGrantActive(input) && input.session_write_grant.allowed_policy_outcomes.includes(outcome);
}

function runnerCanAutoWrite(input: CanonicalWritePolicyInput): boolean {
  return input.runner_trust === 'trusted_interactive' || input.runner_trust === 'trusted_automation';
}

function grantState(input: CanonicalWritePolicyInput): 'allowed' | 'revoked' | 'expired' | 'wrong_session' | 'wrong_realm' | 'wrong_scope' {
  if (input.session_write_grant.revoked_at) return 'revoked';
  if (input.session_write_grant.expires_at && input.evaluated_at) {
    const expiresAt = Date.parse(input.session_write_grant.expires_at);
    const evaluatedAt = Date.parse(input.evaluated_at);
    if (Number.isFinite(expiresAt) && Number.isFinite(evaluatedAt) && expiresAt <= evaluatedAt) {
      return 'expired';
    }
  }
  if (input.session_write_grant.session_id && input.session_write_grant.session_id !== input.session_id) {
    return 'wrong_session';
  }
  if (input.session_write_grant.realm && input.session_write_grant.realm !== input.realm) {
    return 'wrong_realm';
  }
  if (input.session_write_grant.target_scope && !targetScopeCoversClaim(input.session_write_grant.target_scope, input)) {
    return 'wrong_scope';
  }
  return 'allowed';
}

function targetScopeCoversClaim(targetScope: string, input: CanonicalWritePolicyInput): boolean {
  return input.claim.target_slug === targetScope
    || input.claim.target_slug.startsWith(`${targetScope}/`)
    || input.claim.target_id === targetScope
    || input.realm === targetScope;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
