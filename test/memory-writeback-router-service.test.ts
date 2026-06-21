import { describe, expect, test } from 'bun:test';
import { routeMemoryWriteback } from '../src/core/services/memory-writeback-router-service.ts';

const sourceRefs = ['Source: User, direct message, 2026-05-10 12:00 KST'];
const currentHash = 'c'.repeat(64);

describe('memory writeback router service', () => {
  test('routes task mechanics to no_write without a candidate input', () => {
    const result = routeMemoryWriteback({
      content: 'Ran bun test and committed the local branch.',
      evidence_kind: 'task_mechanics',
      source_refs: sourceRefs,
    });

    expect(result.decision).toBe('no_write');
    expect(result.intended_operation).toBe('none');
    expect(result.applied).toBe(false);
    expect(result.reasons).toContain('task_mechanics_not_durable');
    expect(result.writeback_governance_metadata).toMatchObject({
      route_decision: 'no_write',
      intended_operation: 'none',
      apply_mode: 'no_write',
      route_reasons: ['task_mechanics_not_durable'],
      blockers: ['task_mechanics_not_durable'],
      provenance: {
        source_refs_count: 1,
        answer_grounding_source_refs_count: 1,
        corpus_lane_refs_count: 0,
      },
      target_snapshot: {
        input_state: 'omitted',
        expected_content_hash: undefined,
      },
    });
    expect(result.candidate_input).toBeUndefined();
  });

  test('routes targeted inferred sourced signals to candidates', () => {
    const result = routeMemoryWriteback({
      content: 'The agent inferred that Memory Inbox routing is underspecified.',
      evidence_kind: 'agent_inferred',
      source_refs: sourceRefs,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      importance_score: 0.8,
    });

    expect(result.decision).toBe('create_candidate');
    expect(result.intended_operation).toBe('create_memory_candidate_entry');
    expect(result.reasons).toContain('inferred_signal_requires_review');
    expect(result.writeback_governance_metadata).toMatchObject({
      route_decision: 'create_candidate',
      intended_operation: 'create_memory_candidate_entry',
      apply_mode: 'plan_only',
      route_reasons: ['inferred_signal_requires_review'],
      missing_requirements: [],
      blockers: [],
      candidate_only_reason: 'inferred_signal_requires_review',
    });
    expect(result.candidate_input).toMatchObject({
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'The agent inferred that Memory Inbox routing is underspecified.',
      source_refs: sourceRefs,
      generated_by: 'agent',
      extraction_kind: 'inferred',
      confidence_score: 0.5,
      importance_score: 0.8,
      recurrence_score: 0,
      sensitivity: 'work',
      status: 'candidate',
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      reviewed_at: null,
    });
  });

  test('normalizes source refs by trimming and filtering empty entries', () => {
    const result = routeMemoryWriteback({
      content: 'The user prefers sourced router candidate capture.',
      evidence_kind: 'direct_user_statement',
      source_refs: [
        '  Source: User, direct message, 2026-05-10 12:00 KST  ',
        '',
        '   ',
        'Source: User, follow-up, 2026-05-10 12:05 KST',
      ],
    });

    expect(result.decision).toBe('create_candidate');
    expect(result.candidate_input?.source_refs).toEqual([
      'Source: User, direct message, 2026-05-10 12:00 KST',
      'Source: User, follow-up, 2026-05-10 12:05 KST',
    ]);
  });

  test('routes ambiguous signals to open_question candidates', () => {
    const result = routeMemoryWriteback({
      content: 'It is unclear whether this should update canonical MBrain docs.',
      evidence_kind: 'ambiguous',
      source_refs: sourceRefs,
      sensitivity: 'unknown',
    });

    expect(result.decision).toBe('create_candidate');
    expect(result.reasons).toContain('ambiguous_signal_requires_review');
    expect(result.candidate_input).toMatchObject({
      candidate_type: 'open_question',
      extraction_kind: 'ambiguous',
      sensitivity: 'unknown',
      status: 'captured',
    });
  });

  test('routes contradictory signals to captured note_update candidates', () => {
    const result = routeMemoryWriteback({
      content: 'The user corrected an earlier claim about put_page routing.',
      evidence_kind: 'contradicts_existing',
      source_refs: sourceRefs,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
    });

    expect(result.decision).toBe('create_candidate');
    expect(result.reasons).toContain('contradiction_requires_review');
    expect(result.candidate_input).toMatchObject({
      candidate_type: 'note_update',
      extraction_kind: 'inferred',
      status: 'captured',
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
    });
  });

  test('routes code-sensitive signals to captured candidates with revalidation reason', () => {
    const result = routeMemoryWriteback({
      content: 'The router operation should be registered in operations.ts.',
      evidence_kind: 'code_sensitive',
      source_refs: sourceRefs,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
    });

    expect(result.decision).toBe('create_candidate');
    expect(result.reasons).toContain('code_claim_requires_revalidation');
    expect(result.writeback_governance_metadata).toMatchObject({
      apply_mode: 'plan_only',
      candidate_only_reason: 'code_claim_requires_revalidation',
      blockers: [],
    });
    expect(result.candidate_input?.status).toBe('captured');
  });

  test('defers candidate-worthy signals without provenance', () => {
    const result = routeMemoryWriteback({
      content: 'This inferred claim has no usable provenance.',
      evidence_kind: 'agent_inferred',
    });

    expect(result.decision).toBe('defer');
    expect(result.intended_operation).toBe('none');
    expect(result.reasons).toContain('candidate_missing_provenance');
    expect(result.missing_requirements).toEqual(['source_refs']);
    expect(result.writeback_governance_metadata).toMatchObject({
      route_decision: 'defer',
      apply_mode: 'plan_only',
      missing_requirements: ['source_refs'],
      blockers: ['candidate_missing_provenance'],
      provenance: {
        source_refs_count: 0,
        answer_grounding_source_refs_count: 0,
        corpus_lane_refs_count: 0,
      },
    });
    expect(result.candidate_input).toBeUndefined();
  });

  test('does not treat lane id alone as writeback provenance', () => {
    const result = routeMemoryWriteback({
      content: 'The imported source states a durable claim but only names a lane.',
      source_kind: 'import',
      evidence_kind: 'source_extracted',
      corpus_lane: { lane_id: 'imports' },
    });

    expect(result.decision).toBe('defer');
    expect(result.intended_operation).toBe('none');
    expect(result.reasons).toContain('candidate_missing_provenance');
    expect(result.missing_requirements).toContain('source_refs');
    expect(result.candidate_input).toBeUndefined();
  });

  test('does not allow canonical write when only lane id is present', () => {
    const result = routeMemoryWriteback({
      content: 'The imported source requests a canonical write but only names a lane.',
      source_kind: 'import',
      evidence_kind: 'source_extracted',
      corpus_lane: { lane_id: 'imports' },
      allow_canonical_write: true,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      target_snapshot_hash: currentHash,
      sensitivity: 'work',
    });

    expect(result.decision).toBe('defer');
    expect(result.intended_operation).toBe('none');
    expect(result.reasons).toContain('canonical_provenance_required');
    expect(result.missing_requirements).toContain('source_refs');
    expect(result.canonical_write_requirements).toBeUndefined();
  });

  test('allows direct canonical write only with explicit allow flag and target binding', () => {
    const result = routeMemoryWriteback({
      content: 'The user stated that docs/superpowers must stay local-only.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
      allow_canonical_write: true,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      target_snapshot_hash: currentHash,
      sensitivity: 'work',
    });

    expect(result.decision).toBe('canonical_write_allowed');
    expect(result.intended_operation).toBe('put_page');
    expect(result.writeback_governance_metadata).toMatchObject({
      route_decision: 'canonical_write_allowed',
      intended_operation: 'put_page',
      apply_mode: 'canonical_requirements_returned',
      missing_requirements: [],
      blockers: [],
      target_snapshot: {
        input_state: 'hash',
        expected_content_hash: currentHash,
      },
      control_plane_apply_reason: 'canonical_write_requires_put_page_with_expected_content_hash',
    });
    expect(result.canonical_write_requirements).toEqual({
      source_refs: sourceRefs,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      expected_content_hash: currentHash,
      sensitivity: 'work',
    });
    expect(result.candidate_input).toBeUndefined();
  });

  test('allows source-extracted canonical write with explicit allow flag and target binding', () => {
    const result = routeMemoryWriteback({
      content: 'The imported source states that router writeback should prefer candidates.',
      evidence_kind: 'source_extracted',
      source_refs: sourceRefs,
      allow_canonical_write: true,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      target_snapshot_hash: null,
      sensitivity: 'work',
    });

    expect(result.decision).toBe('canonical_write_allowed');
    expect(result.intended_operation).toBe('put_page');
    expect(result.writeback_governance_metadata).toMatchObject({
      apply_mode: 'canonical_requirements_returned',
      target_snapshot: {
        input_state: 'null_absent_assertion',
        expected_content_hash: null,
      },
    });
    expect(result.canonical_write_requirements).toEqual({
      source_refs: sourceRefs,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      expected_content_hash: null,
      sensitivity: 'work',
    });
    expect(result.candidate_input).toBeUndefined();
  });

  test('defers imported source-extracted writeback when lane provenance is absent', () => {
    const result = routeMemoryWriteback({
      content: 'The imported source states a durable claim but lacks lane provenance.',
      source_kind: 'import',
      evidence_kind: 'source_extracted',
      source_refs: sourceRefs,
    });

    expect(result.decision).toBe('defer');
    expect(result.intended_operation).toBe('none');
    expect(result.reasons).toContain('import_lane_required');
    expect(result.missing_requirements).toContain('corpus_lane');
    expect(result.candidate_input).toBeUndefined();
  });

  test('routes imported source-extracted writeback when corpus lane input is present', () => {
    const result = routeMemoryWriteback({
      content: 'The imported source states a durable claim with lane provenance.',
      source_kind: 'import',
      evidence_kind: 'source_extracted',
      source_refs: sourceRefs,
      corpus_lane: { lane_id: 'imports', source_record: 'source-record:meeting-42' },
    });

    expect(result.decision).toBe('create_candidate');
    expect(result.reasons).toContain('extracted_signal_without_canonical_request');
    expect(result.candidate_input?.source_refs).toEqual(expect.arrayContaining([
      ...sourceRefs,
      'corpus_lane:imports',
      'source_record:source-record:meeting-42',
    ]));
  });

  test('routes imported source-extracted writeback when source refs carry lane provenance', () => {
    const result = routeMemoryWriteback({
      content: 'The imported source states a durable claim with source-record provenance.',
      source_kind: 'import',
      evidence_kind: 'source_extracted',
      source_refs: [...sourceRefs, 'source_record:source-record:meeting-42'],
    });

    expect(result.decision).toBe('create_candidate');
    expect(result.candidate_input?.source_refs).toContain('source_record:source-record:meeting-42');
  });

  test('defers canonical writes until the caller supplies a target snapshot hash', () => {
    const result = routeMemoryWriteback({
      content: 'The user stated that canonical writes should use optimistic concurrency.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
      allow_canonical_write: true,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      sensitivity: 'work',
    });

    expect(result.decision).toBe('defer');
    expect(result.intended_operation).toBe('none');
    expect(result.reasons).toContain('canonical_missing_target_snapshot_hash');
    expect(result.missing_requirements).toContain('target_snapshot_hash');
    expect(result.canonical_write_requirements).toBeUndefined();
  });

  test('defers personal canonical targets instead of routing them to put_page', () => {
    const profile = routeMemoryWriteback({
      content: 'The user prefers private weekend planning notes.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
      allow_canonical_write: true,
      target_object_type: 'profile_memory',
      target_object_id: 'profile:user-preferences',
      scope_id: 'personal:default',
      sensitivity: 'personal',
    });

    expect(profile.decision).toBe('defer');
    expect(profile.intended_operation).toBe('none');
    expect(profile.reasons).toContain('canonical_target_not_page_backed');
    expect(profile.missing_requirements).toContain('canonical_page_target');
    expect(profile.canonical_write_requirements).toBeUndefined();

    const episode = routeMemoryWriteback({
      content: 'The user described a personal episode that should not become a page.',
      evidence_kind: 'source_extracted',
      source_refs: sourceRefs,
      allow_canonical_write: true,
      target_object_type: 'personal_episode',
      target_object_id: 'episode:weekend-planning',
      scope_id: 'personal:default',
      sensitivity: 'personal',
    });

    expect(episode.decision).toBe('defer');
    expect(episode.intended_operation).toBe('none');
    expect(episode.reasons).toContain('canonical_target_not_page_backed');
    expect(episode.missing_requirements).toContain('canonical_page_target');
    expect(episode.canonical_write_requirements).toBeUndefined();
  });

  test('defers direct canonical request without target metadata', () => {
    const result = routeMemoryWriteback({
      content: 'The user provided a direct durable statement.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
      allow_canonical_write: true,
    });

    expect(result.decision).toBe('defer');
    expect(result.reasons).toContain('canonical_target_required');
    expect(result.missing_requirements).toContain('target_object_type');
    expect(result.missing_requirements).toContain('target_object_id');
  });

  test('defers personal target candidates without explicit personal scope and sensitivity', () => {
    const result = routeMemoryWriteback({
      content: 'The user prefers private weekend planning notes.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
      target_object_type: 'profile_memory',
      target_object_id: 'profile:user-preferences',
    });

    expect(result.decision).toBe('defer');
    expect(result.intended_operation).toBe('none');
    expect(result.reasons).toContain('personal_target_scope_required');
    expect(result.reasons).toContain('personal_target_sensitivity_required');
    expect(result.missing_requirements).toContain('scope_id');
    expect(result.missing_requirements).toContain('sensitivity');
    expect(result.candidate_input).toBeUndefined();
  });

  test('defers untyped personal candidates without explicit personal scope and sensitivity', () => {
    const missingSensitivity = routeMemoryWriteback({
      content: 'The user prefers private weekend planning notes.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
      target_object_id: 'profile:user-preferences',
      scope_id: 'personal:default',
    });

    expect(missingSensitivity.decision).toBe('defer');
    expect(missingSensitivity.reasons).toContain('personal_target_sensitivity_required');
    expect(missingSensitivity.missing_requirements).toContain('sensitivity');
    expect(missingSensitivity.candidate_input).toBeUndefined();

    const missingScope = routeMemoryWriteback({
      content: 'The user prefers private weekend planning notes.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
      target_object_type: 'other',
      target_object_id: 'profile:user-preferences',
      sensitivity: 'personal',
    });

    expect(missingScope.decision).toBe('defer');
    expect(missingScope.reasons).toContain('personal_target_scope_required');
    expect(missingScope.missing_requirements).toContain('scope_id');
    expect(missingScope.candidate_input).toBeUndefined();
  });

  test('creates personal target candidates when personal scope and sensitivity are explicit', () => {
    const result = routeMemoryWriteback({
      content: 'The user prefers private weekend planning notes.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
      target_object_type: 'profile_memory',
      target_object_id: 'profile:user-preferences',
      scope_id: 'personal:default',
      sensitivity: 'personal',
    });

    expect(result.decision).toBe('create_candidate');
    expect(result.candidate_input).toMatchObject({
      scope_id: 'personal:default',
      sensitivity: 'personal',
      target_object_type: 'profile_memory',
      target_object_id: 'profile:user-preferences',
    });
  });

  test('captures direct sourced signals as candidates when canonical write is not requested', () => {
    const result = routeMemoryWriteback({
      content: 'The user prefers router-first memory writeback.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
    });

    expect(result.decision).toBe('create_candidate');
    expect(result.reasons).toContain('direct_signal_without_canonical_request');
    expect(result.candidate_input).toMatchObject({
      candidate_type: 'fact',
      extraction_kind: 'manual',
      status: 'captured',
      target_object_type: null,
      target_object_id: null,
    });
  });
});
