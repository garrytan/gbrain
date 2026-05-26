import { describe, expect, test } from 'bun:test';
import {
  CLAIM_TYPES,
  CONSENT_STATES,
  SOURCE_KINDS,
  buildSeededAuthorityMatrix,
  lookupSourceAuthority,
  resolveSourcePolicy,
  type SourceKind,
  type SourcePolicy,
} from '../src/core/source-registry/source-policy';
import {
  appendSourceStatusEvent,
  registerSource,
} from '../src/core/services/source-registry-service';

const expectedKinds = [
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
] as const satisfies readonly SourceKind[];

const expectedGrantedPolicies: Record<SourceKind, Pick<
  SourcePolicy,
  | 'ingest_mode'
  | 'index_mode'
  | 'raw_copy_mode'
  | 'extraction_mode'
  | 'llm_access'
  | 'runner_access'
  | 'automatic_canonical_write_authority'
  | 'chunk_retention'
  | 'restore_window'
  | 'purge_policy'
>> = {
  user_direct: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'none',
    extraction_mode: 'direct_claim',
    llm_access: 'none_unless_requested',
    runner_access: 'none_unless_requested',
    automatic_canonical_write_authority: 'decisions_preferences_auto_sensitive_candidate',
    chunk_retention: 'long_archive',
    restore_window: 'easy_restore',
    purge_policy: 'explicit_user_request',
  },
  codex_session: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'structured_semantic',
    llm_access: 'local_only_redacted',
    runner_access: 'local_only_redacted',
    automatic_canonical_write_authority: 'task_outcomes_auto_inferred_preferences_candidate',
    chunk_retention: 'medium_archive',
    restore_window: 'medium_restore',
    purge_policy: 'purge_transient_mechanics_quickly',
  },
  claude_session: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'structured_semantic',
    llm_access: 'local_only_redacted',
    runner_access: 'local_only_redacted',
    automatic_canonical_write_authority: 'task_outcomes_auto_inferred_preferences_candidate',
    chunk_retention: 'medium_archive',
    restore_window: 'medium_restore',
    purge_policy: 'purge_transient_mechanics_quickly',
  },
  agent_session: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'structured_semantic',
    llm_access: 'local_only_redacted',
    runner_access: 'local_only_redacted',
    automatic_canonical_write_authority: 'task_outcomes_auto_inferred_preferences_candidate',
    chunk_retention: 'medium_archive',
    restore_window: 'medium_restore',
    purge_policy: 'purge_transient_mechanics_quickly',
  },
  manual_note: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'semantic',
    llm_access: 'local_only',
    runner_access: 'local_only',
    automatic_canonical_write_authority: 'decisions_preferences_auto_when_explicit',
    chunk_retention: 'long_archive',
    restore_window: 'easy_restore',
    purge_policy: 'explicit_user_request',
  },
  markdown_file: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'semantic',
    llm_access: 'local_only',
    runner_access: 'local_only',
    automatic_canonical_write_authority: 'candidate_unless_trusted_project_or_user_memory',
    chunk_retention: 'long_archive',
    restore_window: 'repair_through_source_pipeline',
    purge_policy: 'source_reconcile',
  },
  document: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'semantic',
    llm_access: 'redacted_policy_gated',
    runner_access: 'redacted_policy_gated',
    automatic_canonical_write_authority: 'world_project_facts_candidate_or_verify_first',
    chunk_retention: 'source_retention',
    restore_window: 'while_source_retained',
    purge_policy: 'source_retention',
  },
  pdf: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'semantic',
    llm_access: 'redacted_policy_gated',
    runner_access: 'redacted_policy_gated',
    automatic_canonical_write_authority: 'world_project_facts_candidate_or_verify_first',
    chunk_retention: 'source_retention',
    restore_window: 'while_source_retained',
    purge_policy: 'source_retention',
  },
  meeting_transcript: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'summary_only',
    extraction_mode: 'speaker_aware_semantic',
    llm_access: 'redacted_policy_gated',
    runner_access: 'redacted_policy_gated',
    automatic_canonical_write_authority: 'commitments_auto_clear_speaker_target',
    chunk_retention: 'medium_archive',
    restore_window: 'medium_restore',
    purge_policy: 'sensitive_purge_priority',
  },
  code_repo: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'code_aware_semantic',
    llm_access: 'local_only',
    runner_access: 'local_only',
    automatic_canonical_write_authority: 'code_claims_verify_first',
    chunk_retention: 'stale_quickly',
    restore_window: 'reverify_before_answer',
    purge_policy: 'purge_stale_code_claims',
  },
  email: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'summary_only',
    extraction_mode: 'relationship_event_semantic',
    llm_access: 'redacted_explicit_raw_grant',
    runner_access: 'redacted_explicit_raw_grant',
    automatic_canonical_write_authority: 'relationship_candidate_events_verify_first',
    chunk_retention: 'short_raw_long_derived',
    restore_window: 'derived_fact_restore',
    purge_policy: 'short_raw_retention',
  },
  calendar: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'event_semantic',
    llm_access: 'redacted',
    runner_access: 'redacted',
    automatic_canonical_write_authority: 'events_auto_when_target_time_clear',
    chunk_retention: 'medium_archive',
    restore_window: 'while_source_retained',
    purge_policy: 'source_retention',
  },
  browser: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_only',
    extraction_mode: 'preference_topic_summary',
    llm_access: 'redacted_explicit_raw_grant',
    runner_access: 'redacted_explicit_raw_grant',
    automatic_canonical_write_authority: 'preferences_candidate',
    chunk_retention: 'short_retention',
    restore_window: 'limited_restore',
    purge_policy: 'purge_aggressively',
  },
  bookmark: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'topic_resource_summary',
    llm_access: 'local_only',
    runner_access: 'local_only',
    automatic_canonical_write_authority: 'candidate',
    chunk_retention: 'medium_archive',
    restore_window: 'medium_restore',
    purge_policy: 'explicit_user_request',
  },
  chat_export: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'summary_only',
    extraction_mode: 'semantic',
    llm_access: 'redacted_policy_gated',
    runner_access: 'redacted_policy_gated',
    automatic_canonical_write_authority: 'candidate_unless_user_authored_decision_explicit',
    chunk_retention: 'medium_archive',
    restore_window: 'medium_restore',
    purge_policy: 'sensitive_purge_priority',
  },
  slack: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'summary_only',
    extraction_mode: 'semantic',
    llm_access: 'redacted_policy_gated',
    runner_access: 'redacted_policy_gated',
    automatic_canonical_write_authority: 'commitments_candidate_unless_speaker_target_clear',
    chunk_retention: 'medium_archive',
    restore_window: 'medium_restore',
    purge_policy: 'sensitive_purge_priority',
  },
  discord: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'summary_only',
    extraction_mode: 'semantic',
    llm_access: 'redacted_policy_gated',
    runner_access: 'redacted_policy_gated',
    automatic_canonical_write_authority: 'commitments_candidate_unless_speaker_target_clear',
    chunk_retention: 'medium_archive',
    restore_window: 'medium_restore',
    purge_policy: 'sensitive_purge_priority',
  },
  imported_archive: {
    ingest_mode: 'enabled_when_granted',
    index_mode: 'enabled_when_granted',
    raw_copy_mode: 'metadata_chunks',
    extraction_mode: 'semantic',
    llm_access: 'redacted_policy_gated',
    runner_access: 'redacted_policy_gated',
    automatic_canonical_write_authority: 'candidate_until_source_trust_classified',
    chunk_retention: 'source_retention',
    restore_window: 'manual_restore_review',
    purge_policy: 'manual_purge_review',
  },
};

describe('source registry policy defaults', () => {
  test('covers every Phase 01 source kind including user_direct', () => {
    expect(SOURCE_KINDS).toEqual(expectedKinds);
    expect(SOURCE_KINDS).toContain('user_direct');
  });

  test('covers every minimal consent state', () => {
    expect(CONSENT_STATES).toEqual(['not_requested', 'granted', 'denied', 'revoked']);
  });

  test('resolves seeded defaults for every source kind with schema-shaped fields', () => {
    for (const kind of SOURCE_KINDS) {
      const resolution = resolveSourcePolicy({
        source_kind: kind,
        consent_state: 'granted',
        enabled: true,
      });

      expect(resolution.policy).toMatchObject(expectedGrantedPolicies[kind]);
      expect(resolution.policy).toHaveProperty('candidate_route_conditions');
      expect(resolution.policy).toHaveProperty('conflict_route_conditions');
      expect(resolution.policy).toHaveProperty('forgetting_lifecycle');
      expect(resolution.policy).toHaveProperty('export_reconcile_behavior');
      expect(resolution.processing.can_ingest).toBe(true);
      expect(resolution.processing.can_extract).toBe(true);
    }
  });

  test('keeps advanced overrides separate from minimal consent', () => {
    const resolution = resolveSourcePolicy({
      source_kind: 'markdown_file',
      consent_state: 'granted',
      enabled: true,
      overrides: {
        raw_copy_mode: 'summary_only',
        llm_access: 'redacted_policy_gated',
        automatic_canonical_write_authority: 'verify_first',
      },
    });

    expect(resolution.consent_state).toBe('granted');
    expect(resolution.policy.raw_copy_mode).toBe('summary_only');
    expect(resolution.policy.llm_access).toBe('redacted_policy_gated');
    expect(resolution.policy.automatic_canonical_write_authority).toBe('verify_first');
    expect(resolution.applied_overrides).toEqual([
      'raw_copy_mode',
      'llm_access',
      'automatic_canonical_write_authority',
    ]);
  });
});

describe('source registry consent and status policy', () => {
  test('blocks future processing unless minimal consent is granted', () => {
    for (const consent_state of CONSENT_STATES.filter((state) => state !== 'granted')) {
      const resolution = resolveSourcePolicy({
        source_kind: 'manual_note',
        consent_state,
        enabled: true,
      });

      expect(resolution.processing).toMatchObject({
        can_ingest: false,
        can_index: false,
        can_extract: false,
        can_use_llm: false,
        can_use_runner: false,
        can_auto_write: false,
      });
      expect(resolution.processing.blocked_by).toContain(consent_state);
    }
  });

  test('pause and revoke prevent future processing while preserving policy inspection', () => {
    const paused = resolveSourcePolicy({
      source_kind: 'codex_session',
      consent_state: 'granted',
      enabled: true,
      paused_at: '2026-05-20T12:00:00.000Z',
    });
    const revoked = resolveSourcePolicy({
      source_kind: 'codex_session',
      consent_state: 'revoked',
      enabled: true,
    });

    expect(paused.policy.raw_copy_mode).toBe('metadata_chunks');
    expect(paused.processing.can_ingest).toBe(false);
    expect(paused.processing.can_auto_write).toBe(false);
    expect(paused.processing.blocked_by).toContain('paused');
    expect(revoked.processing.can_extract).toBe(false);
    expect(revoked.processing.blocked_by).toContain('revoked');
  });

  test('reports automatic canonical write capability only for auto-authorized defaults', () => {
    for (const kind of ['user_direct', 'codex_session', 'manual_note', 'meeting_transcript', 'calendar'] as const) {
      expect(resolveSourcePolicy({
        source_kind: kind,
        consent_state: 'granted',
        enabled: true,
      }).processing.can_auto_write).toBe(true);
    }

    for (const kind of ['markdown_file', 'document', 'pdf', 'code_repo', 'email', 'browser', 'bookmark', 'chat_export', 'slack', 'discord', 'imported_archive'] as const) {
      expect(resolveSourcePolicy({
        source_kind: kind,
        consent_state: 'granted',
        enabled: true,
      }).processing.can_auto_write).toBe(false);
    }
  });
});

describe('source registry registration and status history', () => {
  test('registers a source from minimal consent and records an initial status event', () => {
    const registration = registerSource({
      kind: 'manual_note',
      display_name: 'Manual notes',
      locator: 'mbrain://manual-notes',
      consent_state: 'granted',
      actor_ref: 'user:test',
      now: '2026-05-20T07:00:00.000Z',
    });

    expect(registration.source).toMatchObject({
      kind: 'manual_note',
      display_name: 'Manual notes',
      locator: 'mbrain://manual-notes',
      consent_state: 'granted',
      enabled: true,
      created_at: '2026-05-20T07:00:00.000Z',
    });
    expect(registration.status_events).toHaveLength(1);
    expect(registration.status_events[0]).toMatchObject({
      source_id: registration.source.id,
      event_type: 'registered',
      previous_state: null,
      next_state: 'granted',
      actor_ref: 'user:test',
      created_at: '2026-05-20T07:00:00.000Z',
    });
  });

  test('appends status events without mutating previous history', () => {
    const registration = registerSource({
      kind: 'codex_session',
      display_name: 'Codex sessions',
      consent_state: 'granted',
      now: '2026-05-20T07:00:00.000Z',
    });
    const nextHistory = appendSourceStatusEvent(registration.status_events, {
      source_id: registration.source.id,
      event_type: 'paused',
      previous_state: 'granted',
      next_state: 'paused',
      actor_ref: 'user:test',
      reason: 'user paused source',
      created_at: '2026-05-20T08:00:00.000Z',
    });

    expect(registration.status_events).toHaveLength(1);
    expect(nextHistory).toHaveLength(2);
    expect(nextHistory.map((event) => event.event_type)).toEqual(['registered', 'paused']);
    expect(nextHistory[1]).toMatchObject({
      previous_state: 'granted',
      next_state: 'paused',
      reason: 'user paused source',
    });
  });
});

describe('source authority matrix seed', () => {
  test('builds a deterministic source-kind by claim-type authority matrix', () => {
    const first = buildSeededAuthorityMatrix();
    const second = buildSeededAuthorityMatrix();
    const uniqueKeys = new Set(first.map((row) => `${row.source_kind}:${row.claim_type}`));

    expect(first).toEqual(second);
    expect(first).toHaveLength(SOURCE_KINDS.length * CLAIM_TYPES.length);
    expect(uniqueKeys.size).toBe(first.length);
  });

  test('looks up deterministic authority outcomes for representative policy routes', () => {
    expect(lookupSourceAuthority('user_direct', 'decision')).toBe('auto_canonical');
    expect(lookupSourceAuthority('user_direct', 'sensitive_personal_info')).toBe('candidate');
    expect(lookupSourceAuthority('codex_session', 'task_outcome')).toBe('auto_canonical');
    expect(lookupSourceAuthority('code_repo', 'code_claim')).toBe('verify_first');
    expect(lookupSourceAuthority('email', 'event')).toBe('verify_first');
    expect(lookupSourceAuthority('browser', 'profile_fact')).toBe('candidate');
    expect(lookupSourceAuthority('document', 'world_fact')).toBe('candidate');
  });
});
