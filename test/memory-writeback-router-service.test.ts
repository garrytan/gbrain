import { describe, expect, test } from 'bun:test';
import { routeMemoryWriteback } from '../src/core/services/memory-writeback-router-service.ts';

const sourceRefs = ['Source: User, direct message, 2026-05-10 12:00 KST'];

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
    expect(result.candidate_input).toBeUndefined();
  });

  test('allows direct canonical write only with explicit allow flag and target binding', () => {
    const result = routeMemoryWriteback({
      content: 'The user stated that docs/superpowers must stay local-only.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
      allow_canonical_write: true,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      sensitivity: 'work',
    });

    expect(result.decision).toBe('canonical_write_allowed');
    expect(result.intended_operation).toBe('put_page');
    expect(result.canonical_write_requirements).toEqual({
      source_refs: sourceRefs,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      sensitivity: 'work',
    });
    expect(result.candidate_input).toBeUndefined();
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
