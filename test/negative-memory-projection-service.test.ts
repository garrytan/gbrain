import { describe, expect, test } from 'bun:test';
import { buildNegativeMemoryProjections } from '../src/core/services/negative-memory-projection-service.ts';

describe('negative memory projection service', () => {
  test('suppresses failed attempts only when applicability anchors still match', () => {
    const projections = buildNegativeMemoryProjections({
      now: '2026-06-06T00:00:00.000Z',
      current_anchors: {
        repo_path: '/repo/mbrain',
        branch_name: 'main',
        command: 'bun test',
      },
      task_attempts: [{
        id: 'attempt-1',
        task_id: 'task-1',
        summary: 'Running only the CLI test missed MCP regressions',
        outcome: 'failed',
        applicability_context: {
          repo_path: '/repo/mbrain',
          branch_name: 'main',
          command: 'bun test',
          valid_until: '2026-06-30T00:00:00.000Z',
        },
        evidence: ['MCP regression was not covered.'],
      }],
    });

    expect(projections[0]).toMatchObject({
      id: 'negative-memory:task-attempt:attempt-1',
      failed_under: {
        repo_path: '/repo/mbrain',
        branch_name: 'main',
        command: 'bun test',
      },
      why_failed: 'Running only the CLI test missed MCP regressions',
      do_not_repeat_if: {
        repo_path: '/repo/mbrain',
        branch_name: 'main',
        command: 'bun test',
      },
      valid_until: '2026-06-30T00:00:00.000Z',
      owner_or_task: 'task:task-1',
      activation: 'suppress_if_valid',
      suppression_applies: true,
    });
    expect(projections[0]?.reason_codes).toContain('applicability_anchors_match');
    expect(projections[0]?.source_refs).toEqual(['task-attempt:attempt-1']);
  });

  test('requires verification when current anchors are missing', () => {
    const projections = buildNegativeMemoryProjections({
      current_anchors: {
        repo_path: '/repo/mbrain',
      },
      task_attempts: [{
        id: 'attempt-1',
        task_id: 'task-1',
        summary: 'The command failed on this branch.',
        outcome: 'failed',
        applicability_context: {
          repo_path: '/repo/mbrain',
          branch_name: 'main',
        },
        evidence: [],
      }],
    });

    expect(projections[0]).toMatchObject({
      activation: 'verify_first',
      suppression_applies: false,
    });
    expect(projections[0]?.reason_codes).toContain('current_anchor_missing:branch_name');
  });

  test('reopen_if disables suppression when changed conditions match', () => {
    const projections = buildNegativeMemoryProjections({
      current_anchors: {
        repo_path: '/repo/mbrain',
        branch_name: 'fixed-branch',
      },
      task_attempts: [{
        id: 'attempt-1',
        task_id: 'task-1',
        summary: 'The old branch failed.',
        outcome: 'failed',
        applicability_context: {
          repo_path: '/repo/mbrain',
          branch_name: 'fixed-branch',
          reopen_if: {
            branch_name: 'fixed-branch',
          },
        },
        evidence: [],
      }],
    });

    expect(projections[0]).toMatchObject({
      activation: 'verify_first',
      suppression_applies: false,
    });
    expect(projections[0]?.reason_codes).toContain('reopen_condition_matched:branch_name');
  });

  test('valid_until disables suppression after expiry', () => {
    const projections = buildNegativeMemoryProjections({
      now: '2026-07-01T00:00:00.000Z',
      current_anchors: {
        repo_path: '/repo/mbrain',
        branch_name: 'main',
      },
      task_attempts: [{
        id: 'attempt-1',
        task_id: 'task-1',
        summary: 'Old failure.',
        outcome: 'failed',
        applicability_context: {
          repo_path: '/repo/mbrain',
          branch_name: 'main',
          valid_until: '2026-06-30T00:00:00.000Z',
        },
        evidence: [],
      }],
    });

    expect(projections[0]).toMatchObject({
      activation: 'verify_first',
      suppression_applies: false,
    });
    expect(projections[0]?.reason_codes).toContain('valid_until_expired');
  });

  test('valid_until fails closed when now is missing', () => {
    const projections = buildNegativeMemoryProjections({
      current_anchors: {
        repo_path: '/repo/mbrain',
        branch_name: 'main',
      },
      task_attempts: [{
        id: 'attempt-1',
        task_id: 'task-1',
        summary: 'Time-bounded failure.',
        outcome: 'failed',
        applicability_context: {
          repo_path: '/repo/mbrain',
          branch_name: 'main',
          valid_until: '2000-01-01T00:00:00.000Z',
        },
        evidence: [],
      }],
    });

    expect(projections[0]).toMatchObject({
      activation: 'verify_first',
      suppression_applies: false,
    });
    expect(projections[0]?.reason_codes).toContain('valid_until_unverified');
  });

  test('keeps rejected and superseded candidates audit-only instead of global suppression', () => {
    const projections = buildNegativeMemoryProjections({
      current_anchors: {
        target_object_id: 'systems/mbrain',
      },
      memory_candidates: [
        {
          id: 'candidate-rejected',
          proposed_content: 'Rejected direction',
          status: 'rejected',
          target_object_id: 'systems/mbrain',
          target_object_type: 'curated_note',
          source_refs: ['memory-candidate:candidate-rejected'],
          review_reason: 'Rejected during review.',
        },
        {
          id: 'candidate-superseded',
          proposed_content: 'Superseded direction',
          status: 'superseded',
          target_object_id: 'systems/mbrain',
          target_object_type: 'curated_note',
          source_refs: ['memory-candidate:candidate-superseded'],
          review_reason: 'Superseded by a newer candidate.',
        },
      ],
    });

    expect(projections.map((projection) => projection.activation)).toEqual([
      'audit_only',
      'audit_only',
    ]);
    expect(projections.every((projection) => projection.suppression_applies === false)).toBe(true);
  });
});
