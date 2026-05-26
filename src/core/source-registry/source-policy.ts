export const SOURCE_KINDS = [
  'user_direct',
  'codex_session',
  'claude_session',
  'agent_session',
  'manual_note',
  'markdown_file',
  'document',
  'pdf',
  'meeting_transcript',
  'code_repo',
  'email',
  'calendar',
  'browser',
  'bookmark',
  'chat_export',
  'slack',
  'discord',
  'imported_archive',
] as const;

export const SOURCE_CONSENT_STATES = [
  'not_requested',
  'granted',
  'denied',
  'revoked',
] as const;

export const CONSENT_STATES = SOURCE_CONSENT_STATES;

export const SOURCE_CLAIM_TYPES = [
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

export const CLAIM_TYPES = SOURCE_CLAIM_TYPES;

export const SOURCE_AUTHORITY_OUTCOMES = [
  'auto_canonical',
  'candidate',
  'verify_first',
  'conflict_check',
  'never_canonical',
  'quarantine',
] as const;

export type SourceKind = typeof SOURCE_KINDS[number];
export type SourceConsentState = typeof SOURCE_CONSENT_STATES[number];
export type SourceClaimType = typeof SOURCE_CLAIM_TYPES[number];
export type SourceAuthorityOutcome = typeof SOURCE_AUTHORITY_OUTCOMES[number];

export interface SourcePolicy {
  source_kind: SourceKind;
  ingest_mode: string;
  index_mode: string;
  extraction_mode: string;
  raw_copy_mode: string;
  chunk_retention: string;
  llm_access: string;
  runner_access: string;
  automatic_canonical_write_authority: string;
  candidate_route_conditions: string[];
  conflict_route_conditions: string[];
  forgetting_lifecycle: string;
  restore_window: string;
  purge_policy: string;
  export_reconcile_behavior: string;
}

export interface SourcePolicyOverride {
  dimension: keyof SourcePolicy;
  value: string | string[];
}

export interface SourcePolicyInput {
  kind?: SourceKind;
  source_kind?: SourceKind;
  consent_state: SourceConsentState;
  enabled?: boolean;
  paused_at?: string | Date | null;
  overrides?: SourcePolicyOverride[] | Partial<Record<keyof SourcePolicy, string | string[]>>;
}

export interface SourceProcessingPolicy {
  can_ingest: boolean;
  can_index: boolean;
  can_extract: boolean;
  can_use_llm: boolean;
  can_use_runner: boolean;
  can_auto_write: boolean;
  blocked_by: string[];
}

export interface ResolvedSourcePolicy {
  consent_state: SourceConsentState;
  policy: SourcePolicy;
  processing: SourceProcessingPolicy;
  applied_overrides: string[];
}

interface SourcePolicySeed extends SourcePolicy {
  default_authority: Partial<Record<SourceClaimType, SourceAuthorityOutcome>>;
}

const SESSION_SOURCE_DEFAULTS = {
  ingest_mode: 'enabled_when_granted',
  index_mode: 'enabled_when_granted',
  extraction_mode: 'structured_semantic',
  raw_copy_mode: 'metadata_chunks',
  chunk_retention: 'medium_archive',
  llm_access: 'local_only_redacted',
  runner_access: 'local_only_redacted',
  automatic_canonical_write_authority: 'task_outcomes_auto_inferred_preferences_candidate',
  candidate_route_conditions: ['inferred_preference', 'ambiguous_task_outcome', 'sensitive_personal_info'],
  conflict_route_conditions: ['competing_task_outcome', 'contradictory_preference'],
  forgetting_lifecycle: 'purge_transient_mechanics_quickly',
  restore_window: 'medium_restore',
  purge_policy: 'purge_transient_mechanics_quickly',
  export_reconcile_behavior: 'task_state_projection',
} satisfies Omit<SourcePolicySeed, 'source_kind' | 'default_authority'>;

const REDACTED_DOCUMENT_DEFAULTS = {
  ingest_mode: 'enabled_when_granted',
  index_mode: 'enabled_when_granted',
  extraction_mode: 'semantic',
  raw_copy_mode: 'metadata_chunks',
  chunk_retention: 'source_retention',
  llm_access: 'redacted_policy_gated',
  runner_access: 'redacted_policy_gated',
  automatic_canonical_write_authority: 'world_project_facts_candidate_or_verify_first',
  candidate_route_conditions: ['world_fact', 'project_fact', 'low_confidence'],
  conflict_route_conditions: ['contradictory_source', 'stale_source'],
  forgetting_lifecycle: 'source_retention',
  restore_window: 'while_source_retained',
  purge_policy: 'source_retention',
  export_reconcile_behavior: 'source_pipeline_reconcile',
} satisfies Omit<SourcePolicySeed, 'source_kind' | 'default_authority'>;

const SUMMARY_REDACTED_DEFAULTS = {
  ingest_mode: 'enabled_when_granted',
  index_mode: 'enabled_when_granted',
  extraction_mode: 'semantic',
  raw_copy_mode: 'summary_only',
  chunk_retention: 'medium_archive',
  llm_access: 'redacted_policy_gated',
  runner_access: 'redacted_policy_gated',
  automatic_canonical_write_authority: 'candidate_unless_user_authored_decision_explicit',
  candidate_route_conditions: ['ambiguous_speaker', 'ambiguous_target', 'sensitive_personal_info'],
  conflict_route_conditions: ['speaker_conflict', 'timeline_conflict'],
  forgetting_lifecycle: 'sensitive_purge_priority',
  restore_window: 'medium_restore',
  purge_policy: 'sensitive_purge_priority',
  export_reconcile_behavior: 'metadata_and_summary_reconcile',
} satisfies Omit<SourcePolicySeed, 'source_kind' | 'default_authority'>;

const DEFAULT_SOURCE_POLICIES: Record<SourceKind, SourcePolicySeed> = {
  user_direct: {
    source_kind: 'user_direct',
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    extraction_mode: 'direct_claim',
    raw_copy_mode: 'none',
    chunk_retention: 'long_archive',
    llm_access: 'none_unless_requested',
    runner_access: 'none_unless_requested',
    automatic_canonical_write_authority: 'decisions_preferences_auto_sensitive_candidate',
    candidate_route_conditions: ['sensitive_personal_info', 'ambiguous_preference'],
    conflict_route_conditions: ['contradicts_existing_canonical'],
    forgetting_lifecycle: 'long_archive',
    restore_window: 'easy_restore',
    purge_policy: 'explicit_user_request',
    export_reconcile_behavior: 'canonical_projection_first',
    default_authority: {
      decision: 'auto_canonical',
      preference: 'auto_canonical',
      sensitive_personal_info: 'candidate',
      inferred_pattern: 'candidate',
    },
  },
  codex_session: {
    source_kind: 'codex_session',
    ...SESSION_SOURCE_DEFAULTS,
    default_authority: sessionAuthority(),
  },
  claude_session: {
    source_kind: 'claude_session',
    ...SESSION_SOURCE_DEFAULTS,
    default_authority: sessionAuthority(),
  },
  agent_session: {
    source_kind: 'agent_session',
    ...SESSION_SOURCE_DEFAULTS,
    default_authority: sessionAuthority(),
  },
  manual_note: {
    source_kind: 'manual_note',
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    extraction_mode: 'semantic',
    raw_copy_mode: 'metadata_chunks',
    chunk_retention: 'long_archive',
    llm_access: 'local_only',
    runner_access: 'local_only',
    automatic_canonical_write_authority: 'decisions_preferences_auto_when_explicit',
    candidate_route_conditions: ['implicit_claim', 'low_confidence'],
    conflict_route_conditions: ['contradicts_existing_canonical'],
    forgetting_lifecycle: 'long_archive',
    restore_window: 'easy_restore',
    purge_policy: 'explicit_user_request',
    export_reconcile_behavior: 'source_pipeline_reconcile',
    default_authority: {
      decision: 'auto_canonical',
      preference: 'auto_canonical',
      project_rule: 'candidate',
      world_fact: 'candidate',
    },
  },
  markdown_file: {
    source_kind: 'markdown_file',
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    extraction_mode: 'semantic',
    raw_copy_mode: 'metadata_chunks',
    chunk_retention: 'long_archive',
    llm_access: 'local_only',
    runner_access: 'local_only',
    automatic_canonical_write_authority: 'candidate_unless_trusted_project_or_user_memory',
    candidate_route_conditions: ['markdown_edit', 'untrusted_projection'],
    conflict_route_conditions: ['db_projection_conflict', 'source_record_conflict'],
    forgetting_lifecycle: 'repair_through_source_pipeline',
    restore_window: 'repair_through_source_pipeline',
    purge_policy: 'source_reconcile',
    export_reconcile_behavior: 'repair_through_source_pipeline',
    default_authority: {
      decision: 'candidate',
      preference: 'candidate',
      project_rule: 'candidate',
      architecture_claim: 'candidate',
    },
  },
  document: {
    source_kind: 'document',
    ...REDACTED_DOCUMENT_DEFAULTS,
    default_authority: documentAuthority(),
  },
  pdf: {
    source_kind: 'pdf',
    ...REDACTED_DOCUMENT_DEFAULTS,
    default_authority: documentAuthority(),
  },
  meeting_transcript: {
    source_kind: 'meeting_transcript',
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    extraction_mode: 'speaker_aware_semantic',
    raw_copy_mode: 'summary_only',
    chunk_retention: 'medium_archive',
    llm_access: 'redacted_policy_gated',
    runner_access: 'redacted_policy_gated',
    automatic_canonical_write_authority: 'commitments_auto_clear_speaker_target',
    candidate_route_conditions: ['ambiguous_speaker', 'ambiguous_target', 'sensitive_personal_info'],
    conflict_route_conditions: ['speaker_conflict', 'timeline_conflict'],
    forgetting_lifecycle: 'sensitive_purge_priority',
    restore_window: 'medium_restore',
    purge_policy: 'sensitive_purge_priority',
    export_reconcile_behavior: 'metadata_and_summary_reconcile',
    default_authority: {
      commitment: 'conflict_check',
      decision: 'candidate',
      relationship: 'candidate',
      sensitive_personal_info: 'quarantine',
    },
  },
  code_repo: {
    source_kind: 'code_repo',
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    extraction_mode: 'code_aware_semantic',
    raw_copy_mode: 'metadata_chunks',
    chunk_retention: 'stale_quickly',
    llm_access: 'local_only',
    runner_access: 'local_only',
    automatic_canonical_write_authority: 'code_claims_verify_first',
    candidate_route_conditions: ['unverified_code_claim'],
    conflict_route_conditions: ['content_hash_mismatch', 'branch_mismatch'],
    forgetting_lifecycle: 'reverify_before_answer_or_purge',
    restore_window: 'reverify_before_answer',
    purge_policy: 'purge_stale_code_claims',
    export_reconcile_behavior: 'live_workspace_verification',
    default_authority: {
      code_claim: 'verify_first',
      architecture_claim: 'verify_first',
      project_rule: 'candidate',
    },
  },
  email: {
    source_kind: 'email',
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    extraction_mode: 'relationship_event_semantic',
    raw_copy_mode: 'summary_only',
    chunk_retention: 'short_raw_long_derived',
    llm_access: 'redacted_explicit_raw_grant',
    runner_access: 'redacted_explicit_raw_grant',
    automatic_canonical_write_authority: 'relationship_candidate_events_verify_first',
    candidate_route_conditions: ['relationship', 'ambiguous_event'],
    conflict_route_conditions: ['identity_conflict', 'time_conflict'],
    forgetting_lifecycle: 'short_raw_retention',
    restore_window: 'derived_fact_restore',
    purge_policy: 'short_raw_retention',
    export_reconcile_behavior: 'metadata_and_summary_reconcile',
    default_authority: {
      relationship: 'candidate',
      event: 'verify_first',
      commitment: 'candidate',
      sensitive_personal_info: 'quarantine',
    },
  },
  calendar: {
    source_kind: 'calendar',
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    extraction_mode: 'event_semantic',
    raw_copy_mode: 'metadata_chunks',
    chunk_retention: 'medium_archive',
    llm_access: 'redacted',
    runner_access: 'redacted',
    automatic_canonical_write_authority: 'events_auto_when_target_time_clear',
    candidate_route_conditions: ['ambiguous_attendee', 'ambiguous_time'],
    conflict_route_conditions: ['calendar_time_conflict'],
    forgetting_lifecycle: 'medium_archive',
    restore_window: 'while_source_retained',
    purge_policy: 'source_retention',
    export_reconcile_behavior: 'event_reconcile',
    default_authority: {
      event: 'conflict_check',
      commitment: 'candidate',
    },
  },
  browser: {
    source_kind: 'browser',
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    extraction_mode: 'preference_topic_summary',
    raw_copy_mode: 'metadata_only',
    chunk_retention: 'short_retention',
    llm_access: 'redacted_explicit_raw_grant',
    runner_access: 'redacted_explicit_raw_grant',
    automatic_canonical_write_authority: 'preferences_candidate',
    candidate_route_conditions: ['preference', 'topic_interest'],
    conflict_route_conditions: ['preference_conflict'],
    forgetting_lifecycle: 'purge_aggressively',
    restore_window: 'limited_restore',
    purge_policy: 'purge_aggressively',
    export_reconcile_behavior: 'metadata_only_reconcile',
    default_authority: {
      preference: 'candidate',
      inferred_pattern: 'candidate',
      sensitive_personal_info: 'quarantine',
    },
  },
  bookmark: {
    source_kind: 'bookmark',
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    extraction_mode: 'topic_resource_summary',
    raw_copy_mode: 'metadata_chunks',
    chunk_retention: 'medium_archive',
    llm_access: 'local_only',
    runner_access: 'local_only',
    automatic_canonical_write_authority: 'candidate',
    candidate_route_conditions: ['resource_summary', 'preference'],
    conflict_route_conditions: ['source_conflict'],
    forgetting_lifecycle: 'medium_archive',
    restore_window: 'medium_restore',
    purge_policy: 'explicit_user_request',
    export_reconcile_behavior: 'resource_reconcile',
    default_authority: {
      source_summary: 'candidate',
      preference: 'candidate',
    },
  },
  chat_export: {
    source_kind: 'chat_export',
    ...SUMMARY_REDACTED_DEFAULTS,
    default_authority: chatAuthority(),
  },
  slack: {
    source_kind: 'slack',
    ...SUMMARY_REDACTED_DEFAULTS,
    automatic_canonical_write_authority: 'commitments_candidate_unless_speaker_target_clear',
    default_authority: chatAuthority(),
  },
  discord: {
    source_kind: 'discord',
    ...SUMMARY_REDACTED_DEFAULTS,
    automatic_canonical_write_authority: 'commitments_candidate_unless_speaker_target_clear',
    default_authority: chatAuthority(),
  },
  imported_archive: {
    source_kind: 'imported_archive',
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    extraction_mode: 'semantic',
    raw_copy_mode: 'metadata_chunks',
    chunk_retention: 'source_retention',
    llm_access: 'redacted_policy_gated',
    runner_access: 'redacted_policy_gated',
    automatic_canonical_write_authority: 'candidate_until_source_trust_classified',
    candidate_route_conditions: ['unclassified_trust', 'low_confidence'],
    conflict_route_conditions: ['source_conflict', 'stale_archive'],
    forgetting_lifecycle: 'manual_purge_review',
    restore_window: 'manual_restore_review',
    purge_policy: 'manual_purge_review',
    export_reconcile_behavior: 'source_pipeline_reconcile',
    default_authority: {
      source_summary: 'candidate',
      world_fact: 'candidate',
      relationship: 'candidate',
      sensitive_personal_info: 'quarantine',
    },
  },
};

export function getDefaultSourcePolicy(kind: SourceKind): SourcePolicy {
  const { default_authority: _defaultAuthority, ...policy } = DEFAULT_SOURCE_POLICIES[kind];
  return clonePolicy(policy);
}

export function resolveSourcePolicy(input: SourcePolicyInput): ResolvedSourcePolicy {
  const sourceKind = input.source_kind ?? input.kind;
  if (!sourceKind) throw new Error('source_kind is required');
  const overrides = normalizeOverrides(input.overrides);
  const policy = applySourcePolicyOverrides(getDefaultSourcePolicy(sourceKind), overrides);
  const blockers = processingBlockers(input);
  const allowed = blockers.length === 0;

  return {
    consent_state: input.consent_state,
    policy,
    processing: {
      can_ingest: allowed,
      can_index: allowed,
      can_extract: allowed,
      can_use_llm: allowed && policy.llm_access !== 'none_unless_requested',
      can_use_runner: allowed && policy.runner_access !== 'none_unless_requested',
      can_auto_write: allowed && policyAllowsAutomaticCanonicalWrite(policy.automatic_canonical_write_authority),
      blocked_by: blockers,
    },
    applied_overrides: overrides.map((override) => override.dimension),
  };
}

export function applySourcePolicyOverrides(
  policy: SourcePolicy,
  overrides: readonly SourcePolicyOverride[],
): SourcePolicy {
  const next = clonePolicy(policy);
  for (const override of overrides) {
    if (override.dimension === 'source_kind') continue;
    const currentValue = next[override.dimension];
    if (Array.isArray(currentValue)) {
      (next[override.dimension] as string[]) = normalizeStringArray(override.value);
    } else if (typeof override.value === 'string') {
      (next[override.dimension] as string) = override.value;
    } else {
      throw new Error(`${override.dimension} override must be a string`);
    }
  }
  return next;
}

export function lookupSourceAuthority(
  sourceKind: SourceKind,
  claimType: SourceClaimType,
): SourceAuthorityOutcome {
  return DEFAULT_SOURCE_POLICIES[sourceKind].default_authority[claimType] ?? 'candidate';
}

export function buildSeededAuthorityMatrix(): Array<{
  source_kind: SourceKind;
  claim_type: SourceClaimType;
  outcome: SourceAuthorityOutcome;
}> {
  return SOURCE_KINDS.flatMap((source_kind) => (
    SOURCE_CLAIM_TYPES.map((claim_type) => ({
      source_kind,
      claim_type,
      outcome: lookupSourceAuthority(source_kind, claim_type),
    }))
  ));
}

export function sourceProcessingAllowed(input: SourcePolicyInput): boolean {
  return processingBlockers(input).length === 0;
}

export function isSourceKind(value: string): value is SourceKind {
  return SOURCE_KINDS.includes(value as SourceKind);
}

export function isSourceConsentState(value: string): value is SourceConsentState {
  return SOURCE_CONSENT_STATES.includes(value as SourceConsentState);
}

export function isSourceClaimType(value: string): value is SourceClaimType {
  return SOURCE_CLAIM_TYPES.includes(value as SourceClaimType);
}

function processingBlockers(input: SourcePolicyInput): string[] {
  const enabled = input.enabled ?? input.consent_state === 'granted';
  const blockers: string[] = [];
  if (input.consent_state !== 'granted') blockers.push(input.consent_state);
  if (!enabled) blockers.push('disabled');
  if (input.paused_at != null) blockers.push('paused');
  return blockers;
}

function policyAllowsAutomaticCanonicalWrite(authority: string): boolean {
  const normalized = authority.toLowerCase();
  if (normalized.includes('verify_first')) return false;
  if (normalized === 'candidate' || normalized.startsWith('candidate')) return false;
  return normalized.includes('auto');
}

function clonePolicy(policy: SourcePolicy): SourcePolicy {
  return {
    ...policy,
    candidate_route_conditions: [...policy.candidate_route_conditions],
    conflict_route_conditions: [...policy.conflict_route_conditions],
  };
}

function normalizeStringArray(value: string | string[]): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => entry.trim()).filter(Boolean);
}

function normalizeOverrides(overrides: SourcePolicyInput['overrides']): SourcePolicyOverride[] {
  if (!overrides) return [];
  if (Array.isArray(overrides)) return [...overrides];
  return Object.entries(overrides).map(([dimension, value]) => ({
    dimension: dimension as keyof SourcePolicy,
    value: value as string | string[],
  }));
}

function sessionAuthority(): Partial<Record<SourceClaimType, SourceAuthorityOutcome>> {
  return {
    task_outcome: 'auto_canonical',
    decision: 'candidate',
    preference: 'candidate',
    inferred_pattern: 'candidate',
    sensitive_personal_info: 'quarantine',
  };
}

function documentAuthority(): Partial<Record<SourceClaimType, SourceAuthorityOutcome>> {
  return {
    world_fact: 'candidate',
    project_rule: 'candidate',
    architecture_claim: 'verify_first',
    sensitive_personal_info: 'quarantine',
  };
}

function chatAuthority(): Partial<Record<SourceClaimType, SourceAuthorityOutcome>> {
  return {
    commitment: 'candidate',
    decision: 'candidate',
    relationship: 'candidate',
    preference: 'candidate',
    sensitive_personal_info: 'quarantine',
  };
}
