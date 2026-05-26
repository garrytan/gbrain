import { createHash } from 'crypto';

export const ASSERTION_CLAIM_TYPES = [
  'decision',
  'preference',
  'commitment',
  'event',
  'relationship',
  'profile_fact',
  'project_rule',
  'architecture_claim',
  'code_claim',
  'task_outcome',
  'source_summary',
  'world_fact',
  'inferred_pattern',
  'sensitive_personal_info',
] as const;

export const ASSERTION_AUTHORITY_STATES = [
  'unresolved',
  'candidate',
  'canonical',
  'conflicted',
  'rejected',
] as const;

export const ASSERTION_LIFECYCLE_STATES = [
  'active',
  'stale',
  'expired',
  'archived',
  'purged',
] as const;

export const ASSERTION_CONTRIBUTION_TYPES = [
  'supports',
  'contradicts',
  'supersedes',
  'superseded_by',
  'context',
  'audit_only',
] as const;

export type AssertionClaimType = typeof ASSERTION_CLAIM_TYPES[number];
export type AssertionAuthorityState = typeof ASSERTION_AUTHORITY_STATES[number];
export type AssertionLifecycleState = typeof ASSERTION_LIFECYCLE_STATES[number];
export type AssertionContributionType = typeof ASSERTION_CONTRIBUTION_TYPES[number];
export type JsonValue = unknown;
export type AssertionAuthoritySummary = string | Record<string, number>;

export interface ExtractedClaimInput {
  id?: string;
  source_id?: string;
  source_item_id?: string;
  source_chunk_id?: string;
  extractor_kind?: string;
  extractor_version?: string;
  runner_job_id?: string | null;
  session_id?: string | null;
  task_event_id?: string | null;
  claim_text: string;
  claim_type: AssertionClaimType;
  target_hint: string;
  property_hint: string;
  value_json: JsonValue;
  confidence: number;
  sensitivity_level?: string;
  prompt_injection_flag?: boolean;
  secret_flag?: boolean;
  valid_from?: string | null;
  valid_until?: string | null;
}

export interface AssertionEvidenceInput {
  id?: string;
  assertion_id: string;
  extracted_claim_id: string;
  source_id: string;
  source_item_id: string;
  source_chunk_id: string;
  session_id?: string | null;
  task_event_id?: string | null;
  contribution_type: AssertionContributionType;
  evidence_authority: string;
  evidence_confidence: number;
  valid_from?: string | null;
  valid_until?: string | null;
}

export interface ExtractedClaim {
  id: string;
  source_id: string;
  source_item_id: string;
  source_chunk_id: string;
  extractor_kind: string;
  extractor_version: string;
  runner_job_id: string | null;
  claim_text: string;
  claim_type: AssertionClaimType;
  target_hint: string;
  property_hint: string;
  value_json: JsonValue;
  confidence: number;
  sensitivity_level: string;
  prompt_injection_flag: boolean;
  secret_flag: boolean;
  status: 'pending' | 'pending_resolution' | 'resolved' | 'rejected';
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
}

export interface AssertionRecord {
  id: string;
  claim_type: AssertionClaimType;
  target_type: string;
  target_id: string | null;
  target_slug: string | null;
  property: string;
  value_json: JsonValue;
  normalized_claim: string;
  authority_summary: AssertionAuthoritySummary;
  confidence: number;
  evidence_count: number;
  authority_state: AssertionAuthorityState;
  lifecycle_state: AssertionLifecycleState;
  valid_from: string | null;
  valid_until: string | null;
  supersedes_assertion_id: string | null;
  superseded_by_assertion_id: string | null;
  conflict_set_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssertionEventRecord {
  id: string;
  assertion_id: string;
  event_type: string;
  from_authority_state: AssertionAuthorityState | null;
  to_authority_state: AssertionAuthorityState | null;
  from_lifecycle_state: AssertionLifecycleState | null;
  to_lifecycle_state: AssertionLifecycleState | null;
  reason: string;
  source_refs_json: string[];
  actor: string;
  job_id: string | null;
  created_at: string;
}

export interface AssertionEvidenceRecord {
  id: string;
  assertion_id: string;
  extracted_claim_id: string;
  source_id: string;
  source_item_id: string;
  source_chunk_id: string;
  session_id: string | null;
  task_event_id: string | null;
  contribution_type: AssertionContributionType;
  evidence_authority: string;
  evidence_confidence: number;
  valid_from: string | null;
  valid_until: string | null;
  revocation_state: 'active' | 'revoked' | 'source_revoked' | 'source_purged';
  forgetting_state: 'retained' | 'stale' | 'expired' | 'archived' | 'purged';
  created_at: string;
}

export interface AssertionLineageRecord {
  id: string;
  assertion_id: string;
  extracted_claim_id: string;
  source_id: string;
  source_item_id: string;
  source_chunk_id: string;
  session_id: string | null;
  task_event_id: string | null;
  created_at: string;
}

export interface AssertionLinkRecord {
  id: string;
  from_assertion_id: string;
  to_assertion_id: string;
  link_type: string;
  created_at: string;
}

export interface ConflictSetRecord {
  id: string;
  target_type: string;
  target_id: string;
  property: string;
  status: 'open' | 'resolved';
  created_at: string;
  updated_at: string;
}

export interface ConflictSetAssertionRecord {
  conflict_set_id: string;
  assertion_id: string;
  role: string;
  created_at: string;
}

export interface TaskEventRecord {
  id: string;
  task_id: string | null;
  session_id: string | null;
  event_kind: string;
  actor: string;
  summary: string;
  payload_hash: string | null;
  source_refs: string[];
  generated_assertion_ids: string[];
  created_at: string;
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${sha256(canonicalJson(parts)).slice(0, 24)}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function normalizeScalar(value: unknown): string {
  return canonicalJson(value).toLowerCase();
}

export function isAssertionClaimType(value: string): value is AssertionClaimType {
  return ASSERTION_CLAIM_TYPES.includes(value as AssertionClaimType);
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}
