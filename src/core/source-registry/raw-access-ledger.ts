import { createHash } from 'crypto';

export type RawAccessPolicyDecision = 'allow' | 'deny';

export interface RawAccessRequest {
  actor_type: string;
  actor_id: string;
  session_id?: string | null;
  job_id?: string | null;
  source_id: string;
  source_item_id: string;
  chunk_ids: readonly string[];
  reason: string;
  input?: string;
  prompt?: string;
  requested_at?: string;
}

export interface RawAccessPolicy {
  consent_state: string;
  enabled: boolean;
  runner_access?: string;
  llm_access?: string;
  paused_at?: string | Date | null;
}

export interface RawAccessDecision {
  policy_decision: RawAccessPolicyDecision;
  reason: string;
  redaction_required: boolean;
}

export interface RawAccessLedgerEntry {
  id: string;
  actor_type: string;
  actor_id: string;
  session_id: string | null;
  job_id: string | null;
  source_id: string;
  source_item_id: string;
  chunk_ids: string[];
  reason: string;
  policy_decision: RawAccessPolicyDecision;
  policy_reason: string;
  prompt_hash: string | null;
  input_hash: string | null;
  timestamp: string;
}

export interface RawAccessLedgerScope {
  source_id?: string;
  source_item_id?: string;
  actor_id?: string;
  actor_type?: string;
  policy_decision?: RawAccessPolicyDecision;
  chunk_id?: string;
}

export function evaluateRawAccessRequest(
  request: RawAccessRequest,
  policy: RawAccessPolicy,
): RawAccessDecision {
  if (policy.consent_state !== 'granted') {
    return {
      policy_decision: 'deny',
      reason: `source_consent_${policy.consent_state}`,
      redaction_required: true,
    };
  }
  if (!policy.enabled) {
    return { policy_decision: 'deny', reason: 'source_disabled', redaction_required: true };
  }
  if (policy.paused_at != null) {
    return { policy_decision: 'deny', reason: 'source_paused', redaction_required: true };
  }
  if (request.chunk_ids.length === 0) {
    return { policy_decision: 'deny', reason: 'chunk_scope_required', redaction_required: true };
  }
  const access = accessForActor(request.actor_type, policy);
  if (!accessAllowsActor(access)) {
    return {
      policy_decision: 'deny',
      reason: `${policyActorName(request.actor_type)}_access_denied`,
      redaction_required: true,
    };
  }
  return {
    policy_decision: 'allow',
    reason: 'scoped_access_allowed',
    redaction_required: accessRequiresRedaction(access),
  };
}

export function buildRawAccessLedgerEntry(
  request: RawAccessRequest,
  decision: RawAccessDecision,
): RawAccessLedgerEntry {
  const timestamp = request.requested_at ?? new Date().toISOString();
  return {
    id: stableId(
      'raw-access',
      request.actor_type,
      request.actor_id,
      request.source_id,
      request.source_item_id,
      request.chunk_ids.join(','),
      timestamp,
    ),
    actor_type: request.actor_type,
    actor_id: request.actor_id,
    session_id: request.session_id ?? null,
    job_id: request.job_id ?? null,
    source_id: request.source_id,
    source_item_id: request.source_item_id,
    chunk_ids: [...request.chunk_ids],
    reason: request.reason,
    policy_decision: decision.policy_decision,
    policy_reason: decision.reason,
    prompt_hash: request.prompt ? sha256(request.prompt) : null,
    input_hash: request.input ? sha256(request.input) : null,
    timestamp,
  };
}

export function readRawAccessLedgerScope(
  entries: readonly RawAccessLedgerEntry[],
  scope: RawAccessLedgerScope,
): RawAccessLedgerEntry[] {
  return entries.filter((entry) => {
    if (scope.source_id && entry.source_id !== scope.source_id) return false;
    if (scope.source_item_id && entry.source_item_id !== scope.source_item_id) return false;
    if (scope.actor_id && entry.actor_id !== scope.actor_id) return false;
    if (scope.actor_type && entry.actor_type !== scope.actor_type) return false;
    if (scope.policy_decision && entry.policy_decision !== scope.policy_decision) return false;
    if (scope.chunk_id && !entry.chunk_ids.includes(scope.chunk_id)) return false;
    return true;
  });
}

function accessAllowsActor(access: string | undefined): boolean {
  if (!access) return false;
  return !['none', 'none_unless_requested', 'denied'].includes(access);
}

function accessForActor(actorType: string, policy: RawAccessPolicy): string | undefined {
  if (actorType === 'llm') return policy.llm_access;
  if (['runner', 'daemon', 'mcp', 'cli'].includes(actorType)) return policy.runner_access;
  return undefined;
}

function policyActorName(actorType: string): string {
  if (actorType === 'llm') return 'llm';
  if (['runner', 'daemon', 'mcp', 'cli'].includes(actorType)) return 'runner';
  return 'raw';
}

function accessRequiresRedaction(access: string | undefined): boolean {
  return Boolean(access && access.includes('redacted'));
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${sha256(parts.join('\0')).slice(0, 24)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
