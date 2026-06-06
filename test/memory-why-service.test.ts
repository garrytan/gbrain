import { describe, expect, test } from 'bun:test';
import { buildMemoryWhy } from '../src/core/services/memory-why-service.ts';
import type { MemoryActivationPolicyDecision, NegativeMemoryProjection } from '../src/core/types.ts';

describe('memory-why service', () => {
  test('builds concise explanation from canonical reads, omitted candidates, revalidations, and suppressions', () => {
    const suppression: NegativeMemoryProjection = {
      id: 'negative-memory:task-attempt:1',
      failed_under: { repo: 'mbrain', command: 'bun test' },
      why_failed: 'Old command failed before dependency install.',
      do_not_repeat_if: { repo: 'mbrain', command: 'bun test' },
      reopen_if: {},
      valid_until: null,
      source_refs: ['task-attempt:1'],
      owner_or_task: 'task:t1',
      activation: 'suppress_if_valid',
      suppression_applies: true,
      reason_codes: ['applicability_anchors_match'],
    };

    const report = buildMemoryWhy({
      selected_selectors: [
        { selector_id: 'compiled_truth:workspace:default:systems/mbrain', kind: 'compiled_truth' },
        { selector_id: 'section:workspace:default:systems/mbrain#runtime', kind: 'section' },
      ],
      candidate_signals: [
        {
          candidate_id: 'candidate:direction',
          activation: 'candidate_only',
          reason_codes: ['memory_candidate'],
        },
      ],
      activation_decisions: [
        activationDecision('code:claim', 'verify_first', 'verify_first', ['stale_artifact']),
      ],
      negative_memory: [suppression],
      trace_refs: ['retrieval_trace:trace-1'],
    });

    expect(report.concise_lines).toEqual([
      'Used canonical reads: 2',
      'Ignored Inbox leads: 1 candidate_only',
      'Revalidated: 1 verify_first',
      'Suppressed repeated work: 1',
      'Trace: retrieval_trace:trace-1',
    ]);
    expect(report.concise_lines.length).toBeLessThanOrEqual(5);
    expect(report.counts).toMatchObject({
      canonical_reads_used: 2,
      omitted_candidate_refs: 1,
      revalidation_required: 1,
      suppressions_applied: 1,
    });
  });

  test('builds verbose explanation without turning graph paths into evidence', () => {
    const report = buildMemoryWhy({
      considered_selectors: [
        { selector_id: 'compiled_truth:workspace:default:systems/mbrain', kind: 'compiled_truth' },
        { selector_id: 'context-map:systems/mbrain', kind: 'context_map' },
      ],
      selected_selectors: [
        { selector_id: 'compiled_truth:workspace:default:systems/mbrain', kind: 'compiled_truth' },
      ],
      omitted_candidate_refs: ['memory-candidate:candidate-1'],
      activation_decisions: [
        activationDecision('context-map:systems/mbrain', 'orientation_only', 'orientation_only', ['context_map']),
        activationDecision('candidate:candidate-1', 'candidate_only', 'promote_first', ['memory_candidate']),
      ],
      freshness_snapshot: [
        {
          artifact_id: 'code:claim',
          freshness: 'stale',
          revalidation: 'reverify_code',
          reason_codes: ['stale_artifact'],
        },
      ],
      graph_paths_considered: ['assertion:a -> supports -> assertion:b'],
      scope_policy_snapshot: {
        policy: 'allow',
        resolved_scope: 'work',
        reason: 'explicit_work_scope',
      },
      verbose: true,
    });

    expect(report.verbose).toMatchObject({
      considered_selectors: [
        'compiled_truth:workspace:default:systems/mbrain',
        'context-map:systems/mbrain',
      ],
      selected_selectors: ['compiled_truth:workspace:default:systems/mbrain'],
      omitted_candidate_refs: ['memory-candidate:candidate-1'],
      suppression_reason_codes: [],
      activation_decisions: [
        {
          artifact_id: 'context-map:systems/mbrain',
          decision: 'orientation_only',
          activation_label: 'orientation_only',
        },
        {
          artifact_id: 'candidate:candidate-1',
          decision: 'candidate_only',
          activation_label: 'promote_first',
        },
      ],
      freshness_snapshot: [
        {
          artifact_id: 'code:claim',
          freshness: 'stale',
          revalidation: 'reverify_code',
        },
      ],
      graph_paths_considered: ['assertion:a -> supports -> assertion:b'],
      scope_policy_snapshot: {
        policy: 'allow',
        resolved_scope: 'work',
      },
    });
    expect(report.authority_violations).toEqual([]);
  });

  test('flags candidate and graph-like answer-ground authority violations', () => {
    const report = buildMemoryWhy({
      candidate_signals: [
        {
          candidate_id: 'candidate:bad',
          activation: 'answer_ground' as 'candidate_only',
          reason_codes: ['bad_fixture'],
        },
      ],
      activation_decisions: [
        activationDecision('context-map:bad', 'answer_ground', 'answer_ground', ['bad_fixture']),
        activationDecision('graph-path:path:edge', 'answer_ground', 'answer_ground', ['graph_path']),
      ],
      graph_paths_considered: ['assertion:a -> supports -> assertion:b'],
    });

    expect(report.authority_violations).toContain('candidate_signal_answer_ground:candidate:bad');
    expect(report.authority_violations).toContain('derived_orientation_answer_ground:context-map:bad');
    expect(report.authority_violations).toContain('derived_orientation_answer_ground:graph-path:path:edge');
  });

  test('returns stable zero-count output for empty inputs', () => {
    const report = buildMemoryWhy({});

    expect(report.concise_lines).toEqual([
      'Used canonical reads: 0',
      'Ignored Inbox leads: 0',
      'Revalidated: 0',
      'Suppressed repeated work: 0',
      'Trace: none',
    ]);
    expect(report.verbose).toBeUndefined();
    expect(report.authority_violations).toEqual([]);
  });
});

function activationDecision(
  artifactId: string,
  decision: MemoryActivationPolicyDecision['decision'],
  activationLabel: MemoryActivationPolicyDecision['activation_label'],
  reasonCodes: string[],
): MemoryActivationPolicyDecision {
  return {
    artifact_id: artifactId,
    decision,
    activation_label: activationLabel,
    authority: decision === 'orientation_only' ? 'derived_orientation' : 'operational_memory',
    reason_codes: reasonCodes,
    source_ref: artifactId,
  };
}
