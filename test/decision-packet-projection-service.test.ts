import { describe, expect, test } from 'bun:test';
import { buildDecisionPacketProjections } from '../src/core/services/decision-packet-projection-service.ts';

describe('decision packet projection service', () => {
  test('projects task decisions with rationale, source refs, canonical target, and selectors', () => {
    const packets = buildDecisionPacketProjections({
      task_decisions: [{
        id: 'decision-1',
        task_id: 'task-1',
        summary: 'Use the shared operation surface',
        rationale: 'CLI and MCP must stay aligned.',
        consequences: ['Do not add a CLI-only branch.'],
        validity_context: {
          canonical_target: 'systems/mbrain',
          target_snapshot_hash: 'hash-before',
          valid_until: '2026-06-30T00:00:00.000Z',
          revalidation_path: 'read_canonical',
          reversibility: 'reversible',
          affected_selectors: ['page:systems/mbrain', 'task-decision:decision-1'],
        },
        created_at: new Date('2026-06-06T00:00:00.000Z'),
      }],
      retrieval_traces: [{
        id: 'trace-1',
        task_id: 'task-1',
        source_refs: ['page:systems/mbrain'],
        route: ['task_thread', 'decision_history'],
      }],
    });

    expect(packets).toEqual([
      expect.objectContaining({
        id: 'decision-packet:decision-1',
        decision: 'Use the shared operation surface',
        claim: 'Use the shared operation surface',
        rationale: 'CLI and MCP must stay aligned.',
        owner_or_source: 'task:task-1',
        source_refs: [
          'task-decision:decision-1',
          'page:systems/mbrain',
        ],
        canonical_target: 'systems/mbrain',
        target_snapshot_hash: 'hash-before',
        valid_until: '2026-06-30T00:00:00.000Z',
        revalidation_path: 'read_canonical',
        reversibility: 'reversible',
        affected_selectors: ['page:systems/mbrain', 'task-decision:decision-1'],
        activation: 'citation_only',
        authority: 'operational_memory',
      }),
    ]);
    expect(packets[0]?.source_records).toContainEqual(expect.objectContaining({
      kind: 'task_decision',
      id: 'decision-1',
      authority: 'operational_memory',
    }));
  });

  test('uses active canonical assertion source records before granting answer authority', () => {
    const packets = buildDecisionPacketProjections({
      task_decisions: [{
        id: 'decision-1',
        task_id: 'task-1',
        summary: 'Runtime DB identity must be checked from the active process',
        rationale: 'Config files alone are not runtime evidence.',
        consequences: [],
        validity_context: {
          canonical_target: 'systems/mbrain',
          scope_id: 'workspace:default',
        },
        created_at: new Date('2026-06-06T00:00:00.000Z'),
      }],
      assertions: [{
        id: 'assertion-1',
        scope_id: 'workspace:default',
        claim_text: 'Runtime DB identity must be checked from the active process',
        authority_state: 'canonical',
        lifecycle_state: 'active',
        target_id: 'systems/mbrain',
        source_refs: ['assertion-evidence:evidence-1'],
        valid_until: null,
      }],
    });

    expect(packets[0]).toMatchObject({
      activation: 'answer_ground',
      authority: 'canonical_compiled_truth',
      claim: 'Runtime DB identity must be checked from the active process',
    });
    expect(packets[0]?.source_records).toContainEqual(expect.objectContaining({
      kind: 'assertion',
      id: 'assertion-1',
      authority: 'canonical_compiled_truth',
      lifecycle_state: 'active',
    }));
  });

  test('does not grant answer authority from canonical assertions in a different scope', () => {
    const packets = buildDecisionPacketProjections({
      task_decisions: [{
        id: 'decision-1',
        task_id: 'task-1',
        summary: 'Runtime DB identity must be checked from the active process',
        rationale: 'Scope must match before assertion authority applies.',
        consequences: [],
        validity_context: {
          canonical_target: 'systems/mbrain',
          scope_id: 'workspace:default',
        },
        created_at: new Date('2026-06-06T00:00:00.000Z'),
      }],
      assertions: [{
        id: 'assertion-private',
        scope_id: 'personal:private',
        claim_text: 'Runtime DB identity must be checked from the active process',
        authority_state: 'canonical',
        lifecycle_state: 'active',
        target_id: 'systems/mbrain',
        source_refs: ['assertion-evidence:evidence-private'],
        valid_until: null,
      }],
    });

    expect(packets[0]).toMatchObject({
      activation: 'citation_only',
      authority: 'operational_memory',
    });
    expect(packets[0]?.source_records).not.toContainEqual(expect.objectContaining({
      id: 'assertion-private',
    }));
  });

  test('keeps canonical handoff as provenance without granting answer authority by itself', () => {
    const packets = buildDecisionPacketProjections({
      canonical_handoffs: [{
        id: 'handoff-1',
        scope_id: 'workspace:default',
        candidate_id: 'candidate-1',
        target_object_type: 'curated_note',
        target_object_id: 'concepts/canonical-handoff',
        source_refs: ['memory-candidate:candidate-1'],
        review_reason: 'Ready for canonical update.',
      }],
    });

    expect(packets[0]).toMatchObject({
      id: 'decision-packet:handoff-1',
      decision: 'Canonical handoff to concepts/canonical-handoff',
      canonical_target: 'concepts/canonical-handoff',
      activation: 'citation_only',
      authority: 'source_or_timeline_evidence',
      source_refs: ['canonical-handoff:handoff-1', 'memory-candidate:candidate-1'],
    });
  });

  test('extracts rejected alternatives from failed attempts and rejected candidates with matching anchors', () => {
    const packets = buildDecisionPacketProjections({
      task_decisions: [{
        id: 'decision-1',
        task_id: 'task-1',
        summary: 'Use operation-level integration',
        rationale: 'Keeps CLI and MCP aligned.',
        consequences: [],
        validity_context: {
          repo_path: '/repo/mbrain',
          branch_name: 'main',
          canonical_target: 'systems/mbrain',
        },
        created_at: new Date('2026-06-06T00:00:00.000Z'),
      }],
      task_attempts: [{
        id: 'attempt-1',
        task_id: 'task-1',
        summary: 'Tried a CLI-only implementation',
        outcome: 'failed',
        applicability_context: {
          repo_path: '/repo/mbrain',
          branch_name: 'main',
        },
        evidence: ['MCP path drifted.'],
      }],
      memory_candidates: [{
        id: 'candidate-1',
        proposed_content: 'Use a CLI-only implementation',
        status: 'rejected',
        target_object_id: 'systems/mbrain',
        target_object_type: 'curated_note',
        source_refs: ['memory-candidate:candidate-1'],
        review_reason: 'Rejected because it would drift from MCP.',
      }],
    });

    expect(packets[0]?.rejected_alternatives).toEqual([
      expect.objectContaining({
        source_ref: 'task-attempt:attempt-1',
        summary: 'Tried a CLI-only implementation',
        reason: 'MCP path drifted.',
      }),
      expect.objectContaining({
        source_ref: 'memory-candidate:candidate-1',
        summary: 'Use a CLI-only implementation',
        reason: 'Rejected because it would drift from MCP.',
      }),
    ]);
  });

  test('does not extract failed attempts when any applicability anchor conflicts', () => {
    const packets = buildDecisionPacketProjections({
      task_decisions: [{
        id: 'decision-1',
        task_id: 'task-1',
        summary: 'Use operation-level integration',
        rationale: 'Keeps CLI and MCP aligned.',
        consequences: [],
        validity_context: {
          repo_path: '/repo/mbrain',
          branch_name: 'main',
        },
        created_at: new Date('2026-06-06T00:00:00.000Z'),
      }],
      task_attempts: [{
        id: 'attempt-old-branch',
        task_id: 'task-1',
        summary: 'Tried a CLI-only implementation on an old branch',
        outcome: 'failed',
        applicability_context: {
          repo_path: '/repo/mbrain',
          branch_name: 'old-branch',
        },
        evidence: ['MCP path drifted.'],
      }],
    });

    expect(packets[0]?.rejected_alternatives).toEqual([]);
  });

  test('does not ignore numeric or boolean applicability anchor conflicts', () => {
    const packets = buildDecisionPacketProjections({
      task_decisions: [{
        id: 'decision-1',
        task_id: 'task-1',
        summary: 'Use operation-level integration',
        rationale: 'Keeps CLI and MCP aligned.',
        consequences: [],
        validity_context: {
          repo_path: '/repo/mbrain',
          retry_count: 2,
          dry_run: false,
        },
        created_at: new Date('2026-06-06T00:00:00.000Z'),
      }],
      task_attempts: [{
        id: 'attempt-different-flags',
        task_id: 'task-1',
        summary: 'Tried with different retry and dry-run settings',
        outcome: 'failed',
        applicability_context: {
          repo_path: '/repo/mbrain',
          retry_count: 1,
          dry_run: true,
        },
        evidence: ['Different operational context.'],
      }],
    });

    expect(packets[0]?.rejected_alternatives).toEqual([]);
  });
});
