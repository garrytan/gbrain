import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectMemoryReportInput, runMemoryReport } from '../src/commands/memory-report.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { createLifecycleForgettingServiceForEngine } from '../src/core/services/lifecycle-forgetting-engine-service.ts';
import {
  advanceMemoryCandidateStatus,
  verifyMemoryCandidateEntry,
} from '../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../src/core/services/memory-inbox-promotion-service.ts';
import type { CanonicalTargetProposalEntry, MemoryCandidateEntry } from '../src/core/types.ts';
import {
  buildMemoryReviewReport,
  formatMemoryReviewReport,
  MEMORY_INBOX_REVIEW_PRESSURE_THRESHOLD,
} from '../src/core/services/memory-review-report-service.ts';

const now = '2026-05-22T12:00:00.000Z';
setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

describe('memory review report service', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    while (tempPaths.length > 0) {
      rmSync(tempPaths.pop()!, { recursive: true, force: true });
    }
  });

  test('summarizes automatic memory changes, exceptions, operational health, and report actions', () => {
    const report = buildMemoryReviewReport({
      scope_id: 'workspace:default',
      generated_at: now,
      canonical_memories: [
        {
          id: 'assertion:new',
          target_slug: 'people/ada',
          claim_type: 'preference',
          change_type: 'created',
          summary: 'Ada prefers concise runtime summaries with token sk-testsecret123456.',
          source_refs: ['source-chunk:email-1'],
        },
      ],
      projection_targets: [
        {
          id: 'projection:people/ada',
          target_type: 'markdown_page',
          target_id: 'people/ada',
          locator: 'brain/people/ada.md',
          status: 'applied',
          canonical_changed_since_projection: true,
        },
        {
          id: 'projection:failed',
          target_type: 'markdown_page',
          target_id: 'projects/runtime',
          locator: 'brain/projects/runtime.md',
          status: 'failed',
          canonical_changed_since_projection: false,
        },
      ],
      lifecycle_states: [
        {
          id: 'life:stale',
          entity_type: 'assertion',
          entity_id: 'assertion:old',
          lifecycle_state: 'stale',
          restore_until: '2026-06-01T00:00:00.000Z',
          purge_after: null,
          reason: 'source superseded',
        },
        {
          id: 'life:archived',
          entity_type: 'source_chunk',
          entity_id: 'source-chunk:archived',
          lifecycle_state: 'archived',
          restore_until: '2026-06-10T00:00:00.000Z',
          purge_after: '2026-07-01T00:00:00.000Z',
          reason: 'retention window elapsed',
        },
      ],
      purge_candidates: [
        {
          id: 'purge:item',
          entity_type: 'source_chunk',
          entity_id: 'source-chunk:archived',
          purge_after: '2026-07-01T00:00:00.000Z',
          reason: 'manual purge review',
        },
      ],
      review_items: [
        {
          id: 'candidate:1',
          review_type: 'candidate',
          target_ref: 'people/ada',
          summary: 'Candidate needs provenance review',
          severity: 'medium',
        },
      ],
      conflicts: [
        {
          id: 'conflict:1',
          target_ref: 'people/ada#timezone',
          summary: 'Two active timezone assertions disagree',
          severity: 'high',
        },
      ],
      sources: [
        {
          id: 'source:gmail',
          kind: 'email',
          display_name: 'Primary Gmail',
          consent_state: 'granted',
          enabled: true,
          health_status: 'healthy',
        },
        {
          id: 'source:slack',
          kind: 'slack',
          display_name: 'Team Slack',
          consent_state: 'revoked',
          enabled: false,
          health_status: 'unhealthy',
        },
        {
          id: 'source:calendar',
          kind: 'calendar',
          display_name: 'Calendar',
          consent_state: 'granted',
          enabled: true,
          health_status: 'unhealthy',
        },
      ],
      source_items: [
        { id: 'item:1', source_id: 'source:gmail', external_id: 'm1', status: 'ingested' },
        { id: 'item:2', source_id: 'source:gmail', external_id: 'm2', status: 'skipped' },
      ],
      extracted_claims: [
        { id: 'claim:1', status: 'resolved', claim_type: 'preference' },
        { id: 'claim:2', status: 'pending_resolution', claim_type: 'fact' },
      ],
      policy_denials: [
        { id: 'denial:1', reason: 'low confidence', target_ref: 'people/ada' },
      ],
      quarantined_sources: [
        { id: 'quarantine:1', source_id: 'source:gmail', reason: 'prompt injection' },
      ],
      secret_detections: [
        { id: 'secret:1', source_item_id: 'item:1', kind: 'api_key', severity: 'high' },
      ],
      runner_jobs: [
        {
          id: 'runner:ok',
          task_type: 'consolidation_review',
          status: 'succeeded',
          token_usage_json: { input_tokens: 1000, output_tokens: 200 },
          cost_estimate_usd: 0.012,
        },
        {
          id: 'runner:failed',
          memory_job_id: 'job:runner-failed',
          task_type: 'forgetting_review',
          status: 'failed',
          failure_class: 'runner_unavailable',
          token_usage_json: { input_tokens: 500, output_tokens: 50 },
          cost_estimate_usd: 0.005,
        },
      ],
      jobs: [
        { id: 'job:failed', name: 'daily_report', status: 'failed', failure_class: 'database' },
      ],
      connector_health: [
        {
          connector_id: 'gmail',
          account_id: 'connector-account:gmail:primary',
          health_status: 'healthy',
          credential_status: 'current',
        },
        {
          connector_id: 'slack',
          account_id: 'connector-account:slack:team',
          health_status: 'unhealthy',
          credential_status: 'revoked',
        },
      ],
      candidate_debt: {
        visible_candidate_count: 5,
        missing_provenance_count: 1,
        stale_promoted_without_handoff_count: 1,
        unresolved_exposed_count: 3,
        hard_blocked_by_proposal_count: 0,
        median_review_latency_ms: 5000,
      },
      negative_memory_projections: [
        {
          id: 'negative-memory:task-attempt:old-command',
          failed_under: { repo_path: '/repo/mbrain', command: 'bun test' },
          why_failed: 'Old failed command details should stay out of the report body.',
          do_not_repeat_if: { repo_path: '/repo/mbrain', command: 'bun test' },
          reopen_if: {},
          valid_until: null,
          source_refs: ['task-attempt:old-command'],
          owner_or_task: 'task:memory-report',
          activation: 'suppress_if_valid',
          suppression_applies: true,
          reason_codes: ['applicability_anchors_match'],
        },
      ],
    });

    expect(report.summary).toMatchObject({
      new_canonical_memories: 1,
      updated_projections: 1,
      stale_memories: 1,
      archived_memories: 1,
      purge_candidates: 1,
      review_items: 1,
      conflicts: 1,
      failed_jobs: 2,
      reconciliation_failures: 1,
      unhealthy_sources: 2,
      unhealthy_connectors: 1,
      candidate_missing_provenance: 1,
      candidate_promoted_without_handoff: 1,
      candidate_unresolved_exposed: 3,
      pending_projections: 0,
      stale_projections: 1,
    });
    expect(report.sections.maintenance_health).toEqual({
      candidate_debt: {
        visible_candidate_count: 5,
        missing_provenance_count: 1,
        stale_promoted_without_handoff_count: 1,
        unresolved_exposed_count: 3,
        hard_blocked_by_proposal_count: 0,
        median_review_latency_ms: 5000,
      },
      projection_freshness: {
        total_exception_count: 2,
        pending_reconcile_count: 0,
        failed_count: 1,
        conflict_count: 0,
        stale_count: 1,
      },
    });
    expect(report.sections.source_ingest.by_source).toEqual([
      { source_id: 'source:gmail', ingested: 1, skipped: 1, failed: 0 },
    ]);
    expect(report.sections.extraction.by_status).toEqual([
      { status: 'pending_resolution', count: 1 },
      { status: 'resolved', count: 1 },
    ]);
    expect(report.sections.runner_usage).toMatchObject({
      total_input_tokens: 1500,
      total_output_tokens: 250,
      total_estimated_cost_usd: 0.017,
      failed_runner_jobs: 1,
    });
    const safetyByCategory = new Map(report.sections.safety_states.map((state) => [state.category, state]));
    expect([...safetyByCategory.keys()]).toEqual([
      'trust',
      'source',
      'contradiction',
      'negative_memory',
      'freshness',
      'runner',
      'redaction',
    ]);
    for (const state of report.sections.safety_states) {
      expect(state.report_only).toBe(true);
      expect(state.canonical_write_allowed).toBe(false);
    }
    expect(safetyByCategory.get('trust')).toMatchObject({
      status: 'warn',
      count: 1,
      reason_codes: ['policy_denials_present'],
      sample_ids: ['denial:1'],
    });
    expect(safetyByCategory.get('source')).toMatchObject({
      status: 'warn',
      count: 3,
      reason_codes: ['source_review_required'],
    });
    expect(safetyByCategory.get('contradiction')).toMatchObject({
      status: 'warn',
      count: 1,
      reason_codes: ['unresolved_conflicts_present'],
    });
    expect(safetyByCategory.get('negative_memory')).toMatchObject({
      status: 'warn',
      count: 1,
      reason_codes: ['negative_memory_blocks_present'],
      sample_ids: ['negative-memory:task-attempt:old-command'],
    });
    expect(safetyByCategory.get('freshness')).toMatchObject({
      status: 'warn',
      count: 3,
      reason_codes: ['freshness_review_required'],
    });
    expect(safetyByCategory.get('runner')).toMatchObject({
      status: 'warn',
      count: 1,
      reason_codes: ['runner_failures_present'],
    });
    expect(safetyByCategory.get('redaction')).toMatchObject({
      status: 'warn',
      count: 2,
      reason_codes: ['redaction_review_required'],
    });
    expect(report.actions.map((action) => action.kind)).toEqual(expect.arrayContaining([
      'undo',
      'restore',
      'pin',
      'reject',
      'pause_source',
      'revoke_source',
      'purge',
      'adjust_policy',
    ]));
    expect(report.actions.every((action) => action.route === 'governed_operation')).toBe(true);
    expect(report.actions.every((action) => action.requires_mutation_ledger)).toBe(true);
    expect(report.actions.map((action) => action.operation)).toEqual(expect.arrayContaining([
      'reject_memory_candidate_entry',
      'restore_lifecycle_memory',
      'plan_lifecycle_purge',
      'pause_source_processing',
      'revoke_source_consent',
      'rerun_memory_job',
      'route_memory_writeback',
    ]));
    for (const action of report.actions) {
      expect(operationsByName[action.operation]).toBeDefined();
    }
    expect(report.actions.some((action) => action.operation === 'create_memory_patch_candidate')).toBe(false);
    expect(report.actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'pause_source_processing',
        target_id: 'source:slack',
      }),
      expect.objectContaining({
        operation: 'revoke_source_consent',
        target_id: 'source:slack',
      }),
      expect.objectContaining({
        operation: 'rerun_memory_job',
        target_id: 'runner:failed',
      }),
    ]));
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'pause_source_processing',
        target_id: 'source:calendar',
        params: expect.objectContaining({ source_id: 'source:calendar' }),
      }),
      expect.objectContaining({
        operation: 'revoke_source_consent',
        target_id: 'source:calendar',
        params: expect.objectContaining({ source_id: 'source:calendar' }),
      }),
      expect.objectContaining({
        operation: 'rerun_memory_job',
        target_id: 'job:runner-failed',
        params: expect.objectContaining({ job_id: 'job:runner-failed' }),
      }),
    ]));
    const routedWritebackActions = report.actions.filter((action) => action.operation === 'route_memory_writeback');
    expect(routedWritebackActions.length).toBeGreaterThan(0);
    for (const action of routedWritebackActions) {
      expect(action.params).toMatchObject({
        scope_id: 'workspace:default',
        source_kind: 'cron',
        apply: true,
        allow_canonical_write: false,
      });
      expect(typeof action.params.content).toBe('string');
      expect((action.params.content as string).length).toBeGreaterThan(0);
      expect(action.params.source_refs).toEqual(expect.arrayContaining([expect.stringContaining(`memory-report:${action.kind}:`)]));
      expect([
        'agent_inferred',
        'ambiguous',
        'contradicts_existing',
      ]).toContain(action.params.evidence_kind as string);
      expect([
        'note_update',
        'procedure',
        'open_question',
      ]).toContain(action.params.candidate_type as string);
    }
    expect(report.actions).toContainEqual(expect.objectContaining({
      kind: 'open_audit_trail',
      operation: 'list_memory_mutation_events',
      params: {
        target_kind: 'page',
        target_id: 'people/ada',
        limit: 20,
        offset: 0,
      },
    }));
    expect(report.actions).not.toContainEqual(expect.objectContaining({
      kind: 'open_audit_trail',
      params: expect.objectContaining({
        target_id: 'assertion:new',
        target_slug: 'people/ada',
      }),
    }));
    expect(JSON.stringify(report)).toContain('[REDACTED_SECRET]');
    expect(JSON.stringify(report)).not.toContain('sk-testsecret123456');

    const formatted = formatMemoryReviewReport(report);
    expect(formatted).toContain('Memory Review Report');
    expect(formatted).toContain('Maintenance Health');
    expect(formatted).toContain('Candidate debt: visible 5');
    expect(formatted).toContain('Projection freshness: pending 0');
    expect(formatted).toContain('Safety States (report-only)');
    expect(formatted).toContain('Trust: 1 | policy_denials_present | canonical writes blocked');
    expect(formatted).toContain('Negative Memory: 1 | negative_memory_blocks_present | canonical writes blocked');
    expect(formatted).toContain('[REDACTED_SECRET]');
    expect(formatted).not.toContain('sk-testsecret123456');
    expect(formatted).not.toContain('Old failed command details');
  });

  test('empty reports stay quiet and healthy', () => {
    const report = buildMemoryReviewReport({
      scope_id: 'workspace:default',
      generated_at: now,
    });

    expect(report.health.status).toBe('ok');
    expect(report.summary.failed_jobs).toBe(0);
    expect(report.sections.safety_states.find((state) => state.category === 'negative_memory')).toMatchObject({
      status: 'not_instrumented',
      count: 0,
      report_only: true,
      canonical_write_allowed: false,
    });
    expect(report.actions).toEqual([]);
    expect(formatMemoryReviewReport(report)).toContain('No reportable memory exceptions.');
    expect(formatMemoryReviewReport(report)).not.toContain('Safety States');
  });

  test('updated canonical memories are reportable and not formatted as empty', () => {
    const report = buildMemoryReviewReport({
      scope_id: 'workspace:default',
      generated_at: now,
      canonical_memories: [
        {
          id: 'event:update-page',
          target_kind: 'page',
          target_id: 'people/ada',
          target_slug: 'people/ada',
          change_type: 'updated',
          summary: 'put_page page/people/ada',
          source_refs: ['Source: update test'],
        },
      ],
    });

    expect(report.summary).toMatchObject({
      new_canonical_memories: 0,
      updated_canonical_memories: 1,
    });
    expect(report.actions).toContainEqual(expect.objectContaining({
      kind: 'open_audit_trail',
      operation: 'list_memory_mutation_events',
      params: expect.objectContaining({
        target_kind: 'page',
        target_id: 'people/ada',
      }),
    }));
    const formatted = formatMemoryReviewReport(report);
    expect(formatted).toContain('Canonical Memories (learned this period)');
    expect(formatted).toContain('0 new, 1 updated');
    expect(formatted).not.toContain('No reportable memory exceptions.');
  });

  test('surfaces canonical target proposal review actions by lifecycle status', () => {
    const report = buildMemoryReviewReport({
      scope_id: 'workspace:default',
      generated_at: now,
      review_items: [
        {
          id: 'candidate:no-proposal',
          review_type: 'candidate_staging',
          summary: 'Targetless candidate needs a canonical home.',
          severity: 'medium',
        },
        {
          id: 'candidate:proposed',
          review_type: 'candidate_staging',
          summary: 'Targetless candidate already has a proposed canonical home.',
          severity: 'medium',
        },
        {
          id: 'candidate:approved',
          review_type: 'candidate_staging',
          summary: 'Targetless candidate already has an approved canonical home.',
          severity: 'medium',
        },
        {
          id: 'candidate:patch-staged',
          review_type: 'candidate_staging',
          summary: 'Targetless candidate already has a staged canonical home patch.',
          severity: 'medium',
        },
        {
          id: 'candidate:blocked',
          review_type: 'candidate_staging',
          summary: 'Blocked canonical home proposal should not strand the candidate.',
          severity: 'medium',
        },
        {
          id: 'candidate:rejected',
          review_type: 'candidate_staging',
          summary: 'Rejected canonical home proposal should not strand the candidate.',
          severity: 'medium',
        },
        {
          id: 'candidate:superseded',
          review_type: 'candidate_staging',
          summary: 'Superseded canonical home proposal should not strand the candidate.',
          severity: 'medium',
        },
        {
          id: 'candidate:bound',
          review_type: 'note_update',
          target_ref: 'systems/already-bound',
          summary: 'Bound candidate can use existing promotion hints.',
          severity: 'medium',
        },
      ],
      canonical_target_proposals: [
        canonicalTargetProposal('proposal:proposed', {
          source_candidate_id: 'candidate:proposed',
          status: 'proposed',
        }),
        canonicalTargetProposal('proposal:approved', {
          source_candidate_id: 'candidate:approved',
          status: 'approved',
        }),
        canonicalTargetProposal('proposal:patch-staged', {
          source_candidate_id: 'candidate:patch-staged',
          status: 'patch_staged',
          stub_patch_candidate_id: 'patch:stub',
          stub_patch_state: 'applied',
        }),
        canonicalTargetProposal('proposal:bound', {
          source_candidate_id: 'candidate:bound',
          status: 'bound',
          bound_candidate_ids: ['candidate:bound'],
        }),
        canonicalTargetProposal('proposal:blocked', {
          source_candidate_id: 'candidate:blocked',
          status: 'blocked',
        }),
        canonicalTargetProposal('proposal:rejected', {
          source_candidate_id: 'candidate:rejected',
          status: 'rejected',
        }),
        canonicalTargetProposal('proposal:superseded', {
          source_candidate_id: 'candidate:superseded',
          status: 'superseded',
        }),
      ],
    });

    expect(report.sections.canonical_target_proposals.map((proposal) => proposal.status)).toEqual([
      'proposed',
      'approved',
      'patch_staged',
      'bound',
      'blocked',
      'rejected',
      'superseded',
    ]);
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'propose_canonical_home',
        target_id: 'candidate:no-proposal',
        operation: 'create_canonical_target_proposal',
        params: expect.objectContaining({ candidate_id: 'candidate:no-proposal' }),
      }),
      expect.objectContaining({
        kind: 'propose_canonical_home',
        target_id: 'candidate:blocked',
        operation: 'create_canonical_target_proposal',
        params: expect.objectContaining({ candidate_id: 'candidate:blocked' }),
      }),
      expect.objectContaining({
        kind: 'propose_canonical_home',
        target_id: 'candidate:rejected',
        operation: 'create_canonical_target_proposal',
        params: expect.objectContaining({ candidate_id: 'candidate:rejected' }),
      }),
      expect.objectContaining({
        kind: 'propose_canonical_home',
        target_id: 'candidate:superseded',
        operation: 'create_canonical_target_proposal',
        params: expect.objectContaining({ candidate_id: 'candidate:superseded' }),
      }),
      expect.objectContaining({
        kind: 'approve_canonical_target_proposal',
        target_id: 'proposal:proposed',
        operation: 'approve_canonical_target_proposal',
        params: expect.objectContaining({ proposal_id: 'proposal:proposed' }),
        description: expect.stringContaining('Operation template'),
      }),
      expect.objectContaining({
        kind: 'reject_canonical_target_proposal',
        target_id: 'proposal:proposed',
        operation: 'reject_canonical_target_proposal',
        description: expect.stringContaining('caller-provided review context'),
      }),
      expect.objectContaining({
        kind: 'choose_existing_canonical_page',
        target_id: 'proposal:approved',
        operation: 'complete_canonical_target_proposal_binding',
        params: expect.objectContaining({
          proposal_id: 'proposal:approved',
          require_stub_patch_applied: false,
        }),
        description: expect.stringContaining('caller-provided review context'),
      }),
      expect.objectContaining({
        kind: 'complete_canonical_target_binding',
        target_id: 'proposal:patch-staged',
        operation: 'complete_canonical_target_proposal_binding',
        params: expect.objectContaining({
          proposal_id: 'proposal:patch-staged',
          require_stub_patch_applied: true,
        }),
        description: expect.stringContaining('caller-provided review context'),
      }),
      expect.objectContaining({
        kind: 'approve_candidate',
        target_id: 'candidate:bound',
        operation: 'promote_memory_candidate_entry',
      }),
    ]));
    expect(report.actions).not.toContainEqual(expect.objectContaining({
      kind: 'create_missing_page_stub',
    }));
    for (const targetId of ['candidate:proposed', 'candidate:approved', 'candidate:patch-staged', 'candidate:bound']) {
      expect(report.actions).not.toContainEqual(expect.objectContaining({
        kind: 'propose_canonical_home',
        target_id: targetId,
      }));
    }
    expect(report.actions).not.toContainEqual(expect.objectContaining({
      target_id: 'proposal:approved',
      operation: 'approve_canonical_target_proposal',
    }));
    const templateActions = report.actions.filter((action) => [
      'approve_canonical_target_proposal',
      'reject_canonical_target_proposal',
      'choose_existing_canonical_page',
      'complete_canonical_target_binding',
    ].includes(action.kind));
    expect(templateActions.length).toBeGreaterThan(0);
    for (const action of templateActions) {
      expect(action.description).toContain('session_id, realm_id, actor, and source_refs');
      expect(action.params).not.toHaveProperty('session_id');
      expect(action.params).not.toHaveProperty('realm_id');
      expect(action.params).not.toHaveProperty('actor');
      expect(action.params).not.toHaveProperty('source_refs');
    }

    const formatted = formatMemoryReviewReport(report);
    expect(formatted).toContain('Canonical Target Proposals');
    expect(formatted).toContain('proposal:proposed: proposed systems/example-target');
    expect(formatted).toContain('proposal:patch-staged: patch_staged systems/example-target');
    expect(formatted).toContain('requires caller-provided review context');
  });

  test('classifies stale and failed connector health in the daily report', () => {
    const report = buildMemoryReviewReport({
      scope_id: 'workspace:default',
      generated_at: '2026-06-15T00:00:00.000Z',
      connector_health: [
        {
          connector_id: 'calendar',
          account_id: 'connector-account:calendar:primary',
          health_status: 'healthy',
          credential_status: 'current',
          last_success_at: '2026-06-13T23:00:00.000Z',
          failure_count: 0,
        },
        {
          connector_id: 'slack',
          account_id: 'connector-account:slack:team',
          health_status: 'unhealthy',
          credential_status: 'current',
          last_failure_at: '2026-06-14T22:30:00.000Z',
          failure_count: 3,
          last_error: 'access_token=ya29.leadingSecretToken123456 HTTP 429 rate limit exceeded for sk-testsecret123456 Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 access_token=ya29.testSecretToken123456',
        },
        {
          connector_id: 'gmail',
          account_id: 'connector-account:gmail:primary',
          health_status: 'expired',
          credential_status: 'revoked',
          last_failure_at: '2026-06-14T21:00:00.000Z',
          failure_count: 1,
          last_error: 'OAuth token revoked',
        },
      ],
    });

    expect(report.summary.unhealthy_connectors).toBe(3);
    expect(report.health.reasons).toContain('3 unhealthy connectors');
    expect(report.sections.connector_health).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connector_id: 'calendar',
        staleness_status: 'overdue',
        retry_posture: 'retry_now',
        overdue: true,
      }),
      expect.objectContaining({
        connector_id: 'slack',
        failure_class: 'rate_limited',
        retry_posture: 'wait_for_rate_limit',
        last_error: 'access_token=[REDACTED_SECRET] HTTP 429 rate limit exceeded for [REDACTED_SECRET] Authorization: Bearer [REDACTED_SECRET] access_token=[REDACTED_SECRET]',
      }),
      expect.objectContaining({
        connector_id: 'gmail',
        failure_class: 'auth_expired',
        retry_posture: 'reauthenticate',
      }),
    ]));

    const formatted = formatMemoryReviewReport(report);
    expect(formatted).toContain('Connector Health');
    expect(formatted).toContain('calendar/connector-account:calendar:primary: healthy | overdue | retry:retry_now');
    expect(formatted).toContain('slack/connector-account:slack:team: unhealthy | never_succeeded | failure:rate_limited | retry:wait_for_rate_limit | failures:3');
    expect(formatted).toContain('gmail/connector-account:gmail:primary: expired | credential:revoked | never_succeeded | failure:auth_expired | retry:reauthenticate | failures:1');
    expect(formatted).toContain('last_error: access_token=[REDACTED_SECRET] HTTP 429 rate limit exceeded for [REDACTED_SECRET] Authorization: Bearer [REDACTED_SECRET] access_token=[REDACTED_SECRET]');
    expect(formatted).not.toContain('sk-testsecret123456');
    expect(formatted).not.toContain('ya29.leadingSecretToken123456');
    expect(formatted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(formatted).not.toContain('ya29.testSecretToken123456');
  });

  test('memory-report --save writes the formatted report to brain reports', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'mbrain-memory-report-save-db-'));
    const reportDir = mkdtempSync(join(tmpdir(), 'mbrain-memory-report-save-brain-'));
    tempPaths.push(dbDir, reportDir);
    const engine = new SQLiteEngine();
    const logs: string[] = [];
    const originalLog = console.log;

    await engine.connect({ database_path: join(dbDir, 'brain.sqlite') });
    await engine.initSchema();
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      await runMemoryReport(engine, [
        '--now',
        '2026-06-15T03:04:00.000Z',
        '--save',
        '--report-dir',
        reportDir,
      ]);
    } finally {
      console.log = originalLog;
      await engine.disconnect();
    }

    const savedDir = join(reportDir, 'reports', 'memory-review-report');
    const files = readdirSync(savedDir);
    expect(files.length).toBe(1);
    const saved = readFileSync(join(savedDir, files[0]), 'utf-8');
    expect(saved).toContain('report_type: memory-review-report');
    expect(saved).toContain('Memory Review Report');
    expect(saved).toContain('No reportable memory exceptions.');
    expect(logs.join('\n')).toContain('Saved report:');
  });

  test('memory-report --save rejects a missing report directory value before writing', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'mbrain-memory-report-save-db-'));
    const accidentalDir = join(process.cwd(), '--json');
    rmSync(accidentalDir, { recursive: true, force: true });
    tempPaths.push(dbDir, accidentalDir);
    const engine = new SQLiteEngine();

    await engine.connect({ database_path: join(dbDir, 'brain.sqlite') });
    await engine.initSchema();

    try {
      await expect(runMemoryReport(engine, [
        '--save',
        '--report-dir',
        '--json',
      ])).rejects.toThrow('--report-dir expects a path value');
      expect(() => readdirSync(join(accidentalDir, 'reports'))).toThrow();
    } finally {
      await engine.disconnect();
    }
  });

  test('candidate debt checks promoted handoffs by candidate id, not by a limited scoped handoff page', async () => {
    const timestamp = new Date(now);
    const promotedCandidate: MemoryCandidateEntry = {
      id: 'candidate:promoted-with-handoff',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Promoted candidate with a handoff outside the scoped page.',
      source_refs: ['Source: handoff paging test'],
      generated_by: 'agent',
      extraction_kind: 'extracted',
      confidence_score: 0.8,
      importance_score: 0.6,
      recurrence_score: 0.1,
      sensitivity: 'work',
      status: 'promoted',
      target_object_type: 'curated_note',
      target_object_id: 'people/ada',
      reviewed_at: timestamp,
      review_reason: 'Promoted for handoff paging test.',
      verification_status: 'unverified',
      verification_method: null,
      verification_evidence: null,
      verification_source_refs: [],
      verified_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const requestedHandoffFilters: Array<{ candidate_id?: string }> = [];
    const engine = {
      listMemoryMutationEvents: async () => [],
      listMemoryCandidateEntries: async () => [promotedCandidate],
      listCanonicalHandoffEntries: async (filters?: { candidate_id?: string }) => {
        requestedHandoffFilters.push(filters ?? {});
        if (filters?.candidate_id !== promotedCandidate.id) return [];
        return [{
          id: 'handoff:promoted-with-handoff',
          scope_id: 'workspace:default',
          candidate_id: promotedCandidate.id,
          target_object_type: 'curated_note',
          target_object_id: 'people/ada',
          source_refs: promotedCandidate.source_refs,
          reviewed_at: timestamp,
          review_reason: 'Canonical handoff recorded.',
          interaction_id: null,
          created_at: timestamp,
          updated_at: timestamp,
        }];
      },
    } as unknown as BrainEngine;

    const input = await collectMemoryReportInput(engine, 'workspace:default', 1, now);

    expect(requestedHandoffFilters).toEqual([
      expect.objectContaining({ candidate_id: promotedCandidate.id }),
    ]);
    expect(input.candidate_debt).toMatchObject({
      visible_candidate_count: 1,
      stale_promoted_without_handoff_count: 0,
      unresolved_exposed_count: 0,
    });

    const formatted = formatMemoryReviewReport(buildMemoryReviewReport(input));
    expect(formatted).toContain('No reportable memory exceptions.');
    expect(formatted).not.toContain('Maintenance Health');
  });

  test('candidate debt collection treats unstable-subject blocked proposals as hard-blocked audit state', async () => {
    const timestamp = new Date(now);
    const blockedCandidate: MemoryCandidateEntry = {
      id: 'candidate:blocked',
      scope_id: 'workspace:default',
      candidate_type: 'note_update',
      proposed_content: 'Ambiguous direction note needs a stable subject.',
      source_refs: ['Source: blocked candidate test'],
      generated_by: 'manual',
      extraction_kind: 'inferred',
      confidence_score: 0.7,
      importance_score: 0.7,
      recurrence_score: 0,
      sensitivity: 'work',
      status: 'captured',
      target_object_type: null,
      target_object_id: null,
      reviewed_at: null,
      review_reason: null,
      verification_status: 'unverified',
      verification_method: null,
      verification_evidence: null,
      verification_source_refs: [],
      verified_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const blockedProposal = canonicalTargetProposal('proposal:blocked', {
      source_candidate_id: blockedCandidate.id,
      linked_candidate_ids: [blockedCandidate.id],
      status: 'blocked',
      status_reason: 'unstable_subject_identity',
      proposed_slug: 'concepts/unstable-subject-identity',
    }) as CanonicalTargetProposalEntry;
    const engine = {
      listMemoryMutationEvents: async () => [],
      listMemoryCandidateEntries: async () => [blockedCandidate],
      listCanonicalHandoffEntries: async () => [],
      listCanonicalTargetProposalEntries: async () => [blockedProposal],
    } as unknown as BrainEngine;

    const input = await collectMemoryReportInput(engine, 'workspace:default', 10, now);

    expect(input.candidate_debt).toMatchObject({
      visible_candidate_count: 1,
      unresolved_exposed_count: 0,
      hard_blocked_by_proposal_count: 1,
    });
  });

  test('candidate debt collection uses active proposals even when report proposal display is limited', async () => {
    const timestamp = new Date(now);
    const blockedCandidate: MemoryCandidateEntry = {
      id: 'candidate:blocked-outside-display-limit',
      scope_id: 'workspace:default',
      candidate_type: 'note_update',
      proposed_content: 'Ambiguous direction note needs a stable subject.',
      source_refs: ['Source: blocked candidate limit test'],
      generated_by: 'manual',
      extraction_kind: 'inferred',
      confidence_score: 0.7,
      importance_score: 0.7,
      recurrence_score: 0,
      sensitivity: 'work',
      status: 'captured',
      target_object_type: null,
      target_object_id: null,
      reviewed_at: null,
      review_reason: null,
      verification_status: 'unverified',
      verification_method: null,
      verification_evidence: null,
      verification_source_refs: [],
      verified_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const blockedProposal = canonicalTargetProposal('proposal:blocked-outside-display-limit', {
      source_candidate_id: blockedCandidate.id,
      linked_candidate_ids: [blockedCandidate.id],
      status: 'blocked',
      status_reason: 'unstable_subject_identity',
      proposed_slug: 'concepts/unstable-subject-identity',
    }) as CanonicalTargetProposalEntry;
    const proposalFilters: Array<{ status?: string; limit?: number; offset?: number }> = [];
    const engine = {
      listMemoryMutationEvents: async () => [],
      listMemoryCandidateEntries: async () => [blockedCandidate],
      listCanonicalHandoffEntries: async () => [],
      listCanonicalTargetProposalEntries: async (
        filters?: { status?: string; limit?: number; offset?: number },
      ) => {
        proposalFilters.push(filters ?? {});
        if (filters?.status === 'blocked') return [blockedProposal];
        return [];
      },
    } as unknown as BrainEngine;

    const input = await collectMemoryReportInput(engine, 'workspace:default', 1, now);

    expect(input.canonical_target_proposals).toEqual([]);
    expect(proposalFilters).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'blocked' }),
    ]));
    expect(input.candidate_debt).toMatchObject({
      visible_candidate_count: 1,
      unresolved_exposed_count: 0,
      hard_blocked_by_proposal_count: 1,
    });
  });

  test('hard-blocked proposal debt is reportable without making report health warn', () => {
    const report = buildMemoryReviewReport({
      scope_id: 'workspace:default',
      generated_at: now,
      candidate_debt: {
        visible_candidate_count: 1,
        missing_provenance_count: 0,
        stale_promoted_without_handoff_count: 0,
        unresolved_exposed_count: 0,
        hard_blocked_by_proposal_count: 1,
        median_review_latency_ms: null,
      },
      canonical_target_proposals: [
        canonicalTargetProposal('proposal:blocked', {
          source_candidate_id: 'candidate:blocked',
          linked_candidate_ids: ['candidate:blocked'],
          status: 'blocked',
          status_reason: 'unstable_subject_identity',
          proposed_slug: 'concepts/unstable-subject-identity',
        }),
      ],
    });

    expect(report.summary).toMatchObject({
      candidate_unresolved_exposed: 0,
      candidate_hard_blocked_by_proposal: 1,
    });
    expect(report.health).toEqual({ status: 'ok', reasons: [] });
    expect(formatMemoryReviewReport(report)).toContain('hard-blocked by proposal 1');
    expect(formatMemoryReviewReport(report)).not.toContain('unresolved exposed 1');
  });

  test('collects staged candidate review items without proposed candidate content', async () => {
    const timestamp = new Date(now);
    const stagedCandidates: MemoryCandidateEntry[] = [
      {
        id: 'candidate:staged-work',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Private staged work candidate content must stay gated.',
        source_refs: ['Source: staged work test'],
        generated_by: 'agent',
        extraction_kind: 'extracted',
        confidence_score: 0.61,
        importance_score: 0.4,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'staged_for_review',
        target_object_type: 'curated_note',
        target_object_id: 'people/ada',
        reviewed_at: null,
        review_reason: null,
        verification_status: 'unverified',
        verification_method: null,
        verification_evidence: null,
        verification_source_refs: [],
        verified_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      },
      {
        id: 'candidate:staged-secret',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'sk-secretcandidatecontent123456 should never appear in the report.',
        source_refs: ['Source: staged secret test'],
        generated_by: 'agent',
        extraction_kind: 'extracted',
        confidence_score: 0.7,
        importance_score: 0.8,
        recurrence_score: 0.1,
        sensitivity: 'secret',
        status: 'staged_for_review',
        target_object_type: 'curated_note',
        target_object_id: 'target-secret-should-not-appear-in-summary',
        reviewed_at: null,
        review_reason: null,
        verification_status: 'unverified',
        verification_method: null,
        verification_evidence: null,
        verification_source_refs: [],
        verified_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      },
    ];
    const engine = {
      listMemoryMutationEvents: async () => [],
      listMemoryCandidateEntries: async () => stagedCandidates,
      listCanonicalHandoffEntries: async () => [],
    } as unknown as BrainEngine;

    const input = await collectMemoryReportInput(engine, 'workspace:default', 10, now);
    const report = buildMemoryReviewReport(input);
    const reportJson = JSON.stringify(report);

    expect(input.review_items).toEqual([
      expect.objectContaining({
        id: 'candidate:staged-work',
        summary: expect.stringContaining('content gated'),
        severity: 'medium',
      }),
      expect.objectContaining({
        id: 'candidate:staged-secret',
        summary: expect.stringContaining('content gated'),
        severity: 'high',
      }),
    ]);
    expect(reportJson).not.toContain('Private staged work candidate content');
    expect(reportJson).not.toContain('sk-secretcandidatecontent123456');
    expect(reportJson).toContain('read_candidate_context');
    expect(input.review_items?.find((item) => item.id === 'candidate:staged-secret')?.summary)
      .not.toContain('target-secret-should-not-appear-in-summary');
  });

  test('collects active candidate review items with staging actions only', async () => {
    const timestamp = new Date(now);
    const candidates: MemoryCandidateEntry[] = [
      {
        id: 'candidate:queued',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Queued candidate content must stay gated.',
        source_refs: ['Source: queued candidate test'],
        generated_by: 'agent',
        extraction_kind: 'extracted',
        confidence_score: 0.61,
        importance_score: 0.4,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'candidate',
        target_object_type: 'curated_note',
        target_object_id: 'people/ada',
        reviewed_at: null,
        review_reason: null,
        verification_status: 'unverified',
        verification_method: null,
        verification_evidence: null,
        verification_source_refs: [],
        verified_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      },
    ];
    const engine = {
      listMemoryMutationEvents: async () => [],
      listMemoryCandidateEntries: async () => candidates,
      listCanonicalHandoffEntries: async () => [],
    } as unknown as BrainEngine;

    const input = await collectMemoryReportInput(engine, 'workspace:default', 10, now);
    const report = buildMemoryReviewReport(input);
    const reportJson = JSON.stringify(report);

    expect(input.review_items).toEqual([
      expect.objectContaining({
        id: 'candidate:queued',
        review_type: 'candidate_staging',
        summary: expect.stringContaining('stage for review'),
        severity: 'medium',
      }),
    ]);
    expect(reportJson).not.toContain('Queued candidate content');
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'stage_candidate',
        operation: 'advance_memory_candidate_status',
        target_id: 'candidate:queued',
        params: expect.objectContaining({
          id: 'candidate:queued',
          next_status: 'staged_for_review',
        }),
        requires_mutation_ledger: true,
      }),
    ]));
    expect(report.actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'promote_memory_candidate_entry',
        params: expect.objectContaining({ id: 'candidate:queued' }),
      }),
      expect.objectContaining({
        operation: 'reject_memory_candidate_entry',
        params: expect.objectContaining({ id: 'candidate:queued' }),
      }),
    ]));
  });

  test('collects Phase 12 report evidence from the configured runtime, not only synthetic input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-report-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    await engine.connect({ database_path: join(dir, 'brain.sqlite') });
    await engine.initSchema();

    try {
      await engine.createMemoryMutationEvent({
        id: 'event:canonical-write',
        session_id: 'session:report',
        realm_id: 'realm:default',
        actor: 'mbrain:test',
        operation: 'governed_canonical_write',
        target_kind: 'page',
        target_id: 'people/ada',
        scope_id: 'workspace:default',
        source_refs: ['Source: report test'],
        result: 'applied',
      });
      await engine.createMemoryCandidateEntry({
        id: 'candidate:review',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Ada moved teams.',
        source_refs: ['Source: candidate test'],
        generated_by: 'agent',
        extraction_kind: 'extracted',
        confidence_score: 0.52,
        importance_score: 0.4,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'staged_for_review',
        target_object_type: 'curated_note',
        target_object_id: 'people/ada',
      });
      await engine.createMemoryCandidateEntry({
        id: 'candidate:captured',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Captured but not reviewable yet.',
        source_refs: ['Source: captured candidate test'],
        generated_by: 'agent',
        extraction_kind: 'extracted',
        confidence_score: 0.42,
        importance_score: 0.2,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'captured',
        target_object_type: 'curated_note',
        target_object_id: 'people/ada',
      });
      await engine.createMemoryCandidateEntry({
        id: 'candidate:queued',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Candidate but not staged for review yet.',
        source_refs: ['Source: queued candidate test'],
        generated_by: 'agent',
        extraction_kind: 'extracted',
        confidence_score: 0.48,
        importance_score: 0.25,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'candidate',
        target_object_type: 'curated_note',
        target_object_id: 'people/ada',
      });
      await engine.createMemoryCandidateEntry({
        id: 'candidate:missing-provenance',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Candidate with missing provenance.',
        source_refs: [],
        generated_by: 'agent',
        extraction_kind: 'extracted',
        confidence_score: 0.43,
        importance_score: 0.25,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'candidate',
        target_object_type: 'curated_note',
        target_object_id: 'people/ada',
      });
      await engine.createMemoryCandidateEntry({
        id: 'candidate:promoted-without-handoff',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Promoted but no canonical handoff was recorded.',
        source_refs: ['Source: promoted candidate test'],
        generated_by: 'agent',
        extraction_kind: 'extracted',
        confidence_score: 0.72,
        importance_score: 0.5,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'candidate',
        target_object_type: 'curated_note',
        target_object_id: 'people/ada',
      });
      await advanceMemoryCandidateStatus(engine, {
        id: 'candidate:promoted-without-handoff',
        next_status: 'staged_for_review',
        review_reason: 'Prepared for promotion.',
        reviewed_at: now,
      });
      await verifyMemoryCandidateEntry(engine, {
        id: 'candidate:promoted-without-handoff',
        verification_status: 'verified',
        verification_method: 'source_recheck',
        verification_evidence: 'Checked memory report fixture before promotion.',
        verification_source_refs: ['Fixture verification for candidate:promoted-without-handoff'],
        verified_at: '2026-06-16T00:00:00Z',
      });
      await promoteMemoryCandidateEntry(engine, {
        id: 'candidate:promoted-without-handoff',
        reviewed_at: now,
        review_reason: 'Promoted without handoff for report debt test.',
      });
      await engine.createMemoryCandidateEntry({
        id: 'candidate:secret-hidden',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Secret candidate should be hidden from debt visibility.',
        source_refs: [],
        generated_by: 'agent',
        extraction_kind: 'extracted',
        confidence_score: 0.5,
        importance_score: 0.2,
        recurrence_score: 0.1,
        sensitivity: 'secret',
        status: 'candidate',
        target_object_type: 'curated_note',
        target_object_id: 'people/ada',
      });
      await engine.createTaskThread({
        id: 'task:negative-memory-report',
        scope: 'work',
        title: 'Negative memory report fixture',
        status: 'active',
        repo_path: '/repo/mbrain',
        branch_name: 'main',
        current_summary: 'Runtime report fixture for failed-attempt projection.',
      });
      await engine.recordTaskAttempt({
        id: 'attempt:negative-memory-report',
        task_id: 'task:negative-memory-report',
        summary: 'Running the stale command failed and should be report-only.',
        outcome: 'failed',
        applicability_context: {
          repo_path: '/repo/mbrain',
          branch_name: 'main',
          command: 'bun test:old',
          valid_until: '2026-06-30T00:00:00.000Z',
        },
        evidence: ['Source: failed attempt fixture'],
      });
      await engine.createTaskThread({
        id: 'task:personal-negative-memory-report',
        scope: 'personal',
        title: 'Personal negative memory fixture',
        status: 'active',
        repo_path: null,
        branch_name: null,
        current_summary: 'Personal failed attempt should not appear in workspace report.',
      });
      await engine.recordTaskAttempt({
        id: 'attempt:personal-negative-memory-report',
        task_id: 'task:personal-negative-memory-report',
        summary: 'Personal failed attempt must stay out of the workspace report.',
        outcome: 'failed',
        applicability_context: {
          profile: 'private',
          valid_until: '2026-06-30T00:00:00.000Z',
        },
        evidence: ['Source: personal failed attempt fixture'],
      });

      const lifecycle = createLifecycleForgettingServiceForEngine(engine, () => now);
      await lifecycle.transitionEntity({
        scope_id: 'workspace:default',
        entity_type: 'assertion',
        entity_id: 'assertion:stale',
        to_lifecycle_state: 'stale',
        reason: 'superseded by fresher source',
      });
      await lifecycle.transitionEntity({
        scope_id: 'workspace:default',
        entity_type: 'source_chunk',
        entity_id: 'source-chunk:purge',
        to_lifecycle_state: 'archived',
        reason: 'retention elapsed',
        purge_after: '2026-05-01T00:00:00.000Z',
      });

      const db = (engine as any).database;
      db.query(`
        INSERT INTO sources (id, kind, display_name, consent_state, enabled, created_at, updated_at)
        VALUES ('source:gmail', 'email', 'Gmail', 'granted', 1, ?, ?),
               ('source:slack', 'slack', 'Slack', 'granted', 1, ?, ?)
      `).run(now, now, now, now);
      db.query(`
        INSERT INTO source_items (
          id, source_id, external_id, origin_event, title, ingested_at, content_hash,
          raw_copy_mode, sensitivity_level, ingest_status
        ) VALUES
          ('item:ready', 'source:gmail', 'm1', 'connector_sync', 'Ready', ?, 'h1', 'metadata+chunks', 'normal', 'ready'),
          ('item:failed', 'source:gmail', 'm2', 'connector_sync', 'Failed', ?, 'h2', 'metadata+chunks', 'normal', 'failed')
      `).run(now, now);
      db.query(`
        INSERT INTO source_chunks (
          id, source_item_id, chunk_index, chunk_hash, chunk_text, redacted_text,
          token_count, parser_version, extractor_version, sensitivity_flags,
          prompt_injection_risk, secret_risk, created_at
        ) VALUES
          ('chunk:unsafe', 'item:ready', 0, 'c1', 'ignore previous instructions', '',
           3, 'test', 'test', '[]', 'quarantined', 'none', ?),
          ('chunk:secret', 'item:ready', 1, 'c2', 'token sk-testsecret123456', '[REDACTED_SECRET]',
           3, 'test', 'test', '[]', 'none', 'redacted', ?)
      `).run(now, now);
      db.query(`
        INSERT INTO extracted_claims (
          id, source_id, source_item_id, source_chunk_id, extractor_kind, extractor_version,
          claim_text, claim_type, target_hint, property_hint, value_json, confidence,
          sensitivity_level, status, created_at
        ) VALUES (
          'claim:pending', 'source:gmail', 'item:ready', 'chunk:unsafe', 'stub', 'v1',
          'Ada moved teams', 'profile_fact', 'person:ada', 'team', '{"name":"runtime"}',
          0.66, 'normal', 'pending_resolution', ?
        )
      `).run(now);
      db.query(`
        INSERT INTO conflict_sets (id, target_type, target_id, property, status, created_at, updated_at)
        VALUES ('conflict:team', 'person', 'people/ada', 'team', 'open', ?, ?)
      `).run(now, now);
      db.query(`
        INSERT INTO canonical_write_attempts (
          id, policy_decision, policy_explanation, assertion_ids, assertion_evidence_ids,
          extracted_claim_ids, source_refs, target_projection_ids, actor, status, created_at
        ) VALUES (
          'attempt:denied', 'reject', 'low confidence', '[]', '[]',
          '["claim:pending"]', '["source:gmail"]', '[]', 'mbrain:test', 'conflict', ?
        )
      `).run(now);
      db.query(`
        INSERT INTO canonical_projection_targets (
          id, target_type, target_id, locator, source_assertion_ids, projection_hash,
          rendered_markdown, status, canonical_changed_since_projection, created_at, updated_at
        ) VALUES (
          'projection:people/ada', 'markdown_page', 'people/ada', 'brain/people/ada.md',
          '["assertion:stale"]', 'hash-old', 'Ada', 'failed', 1, ?, ?
        )
      `).run(now, now);
      db.query(`
        INSERT INTO memory_jobs (
          id, name, queue, status, priority, payload_json, progress_json, max_attempts,
          attempts_started, attempts_finished, backoff_type, backoff_delay_ms,
          next_run_at, failure_class, last_error, created_at, updated_at
        ) VALUES (
          'job:runner-failed', 'runner:forgetting-review', 'maintenance', 'failed', 0,
          '{"task_type":"forgetting_review","token_usage_json":{"input_tokens":100,"output_tokens":25},"cost_estimate_usd":0.001}',
          '{}', 1, 1, 1, 'none', 0, ?, 'runner_unavailable', 'runner unavailable', ?, ?
        )
      `).run(now, now, now);
      db.query(`
        CREATE TABLE runner_jobs (
          id TEXT PRIMARY KEY,
          memory_job_id TEXT,
          runner_kind TEXT NOT NULL,
          task_type TEXT NOT NULL,
          source_scope_json TEXT NOT NULL,
          prompt_hash TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          failure_class TEXT,
          token_usage_json TEXT NOT NULL,
          cost_estimate_usd REAL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `).run();
      db.query(`
        INSERT INTO runner_jobs (
          id, memory_job_id, runner_kind, task_type, source_scope_json, prompt_hash, input_hash,
          status, failure_class, token_usage_json, cost_estimate_usd, created_at, updated_at
        ) VALUES (
          'runner-job:durable-degraded', 'job:runner-failed', 'codex', 'consolidation_review', '{}',
          'sha256:prompt', 'sha256:input', 'degraded', 'runner_unavailable',
          '{"input_tokens":50,"output_tokens":10,"total_tokens":60}', 0.002, ?, ?
        )
      `).run(now, now);
      db.query(`
        INSERT INTO credential_refs (
          id, connector_id, account_id, provider, reference, scopes_json,
          rotation_status, health_status, created_at, updated_at
        ) VALUES (
          'credential:slack', 'slack', 'connector-account:slack:team',
          'credential_gateway', 'credential-gateway://slack/team', '[]',
          'revoked', 'unhealthy', ?, ?
        )
      `).run(now, now);
      db.query(`
        INSERT INTO connector_accounts (
          id, connector_id, source_id, account_locator, display_name,
          credential_ref_id, status, created_at, updated_at
        ) VALUES (
          'connector-account:slack:team', 'slack', 'source:slack', 'team',
          'Team Slack', 'credential:slack', 'failed', ?, ?
        )
      `).run(now, now);
      db.query(`
        INSERT INTO connector_sync_states (
          id, account_id, connector_id, health_status, failure_count,
          last_error, created_at, updated_at
        ) VALUES (
          'sync:slack', 'connector-account:slack:team', 'slack',
          'unhealthy', 2, 'revoked token', ?, ?
        )
      `).run(now, now);

      const input = await collectMemoryReportInput(engine, 'workspace:default', 100, now);
      const report = buildMemoryReviewReport(input);

      expect(report.summary).toMatchObject({
        new_canonical_memories: 1,
        stale_memories: 1,
        archived_memories: 1,
        purge_candidates: 1,
        review_items: 4,
        conflicts: 1,
        policy_denials: 1,
        quarantined_sources: 1,
        secret_detections: 1,
        failed_jobs: 1,
        reconciliation_failures: 1,
        unhealthy_sources: 1,
        unhealthy_connectors: 1,
        candidate_missing_provenance: 1,
        candidate_promoted_without_handoff: 1,
        candidate_unresolved_exposed: 4,
        pending_projections: 0,
        stale_projections: 1,
      });
      expect(report.sections.maintenance_health.candidate_debt).toMatchObject({
        visible_candidate_count: 5,
        missing_provenance_count: 1,
        stale_promoted_without_handoff_count: 1,
        unresolved_exposed_count: 4,
      });
      expect(report.sections.maintenance_health.projection_freshness).toMatchObject({
        total_exception_count: 1,
        failed_count: 1,
        stale_count: 1,
      });
      expect(report.sections.source_ingest.by_source).toEqual(expect.arrayContaining([
        { source_id: 'source:gmail', ingested: 1, skipped: 0, failed: 1 },
      ]));
      expect(report.sections.extraction.by_status).toEqual([
        { status: 'pending_resolution', count: 1 },
      ]);
      expect(report.sections.runner_usage).toMatchObject({
        total_input_tokens: 50,
        total_output_tokens: 10,
        total_estimated_cost_usd: 0.002,
        failed_runner_jobs: 1,
      });
      const runtimeSafetyByCategory = new Map(report.sections.safety_states.map((state) => [state.category, state]));
      expect([...runtimeSafetyByCategory.keys()]).toEqual([
        'trust',
        'source',
        'contradiction',
        'negative_memory',
        'freshness',
        'runner',
        'redaction',
      ]);
      for (const state of report.sections.safety_states) {
        expect(state.report_only).toBe(true);
        expect(state.canonical_write_allowed).toBe(false);
      }
      expect(runtimeSafetyByCategory.get('trust')).toMatchObject({
        status: 'warn',
        count: 1,
        reason_codes: ['policy_denials_present'],
      });
      expect(runtimeSafetyByCategory.get('source')).toMatchObject({
        status: 'warn',
        count: 3,
        reason_codes: ['source_review_required'],
      });
      expect(runtimeSafetyByCategory.get('contradiction')).toMatchObject({
        status: 'warn',
        count: 1,
        reason_codes: ['unresolved_conflicts_present'],
      });
      expect(runtimeSafetyByCategory.get('negative_memory')).toMatchObject({
        status: 'warn',
        count: 1,
        reason_codes: ['negative_memory_blocks_present'],
        sample_ids: ['negative-memory:task-attempt:attempt:negative-memory-report'],
      });
      expect(runtimeSafetyByCategory.get('freshness')).toMatchObject({
        status: 'warn',
        count: 2,
        reason_codes: ['freshness_review_required'],
      });
      expect(runtimeSafetyByCategory.get('runner')).toMatchObject({
        status: 'warn',
        count: 1,
        reason_codes: ['runner_failures_present'],
      });
      expect(runtimeSafetyByCategory.get('redaction')).toMatchObject({
        status: 'warn',
        count: 2,
        reason_codes: ['redaction_review_required'],
      });
      const runtimeFormatted = formatMemoryReviewReport(report);
      const runtimeJson = JSON.stringify(report);
      expect(runtimeFormatted).toContain('Safety States (report-only)');
      expect(runtimeFormatted).toContain('Negative Memory: 1 | negative_memory_blocks_present | canonical writes blocked');
      expect(runtimeFormatted).not.toContain('Running the stale command failed');
      expect(runtimeFormatted).not.toContain('Personal failed attempt');
      expect(runtimeJson).not.toContain('Running the stale command failed');
      expect(runtimeJson).not.toContain('Personal failed attempt');
      expect(runtimeJson).not.toContain('Source: failed attempt fixture');
      expect(runtimeJson).not.toContain('Source: personal failed attempt fixture');
      expect(report.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'stage_candidate',
          operation: 'advance_memory_candidate_status',
          params: expect.objectContaining({
            id: 'candidate:queued',
            next_status: 'staged_for_review',
          }),
          requires_mutation_ledger: true,
        }),
        expect.objectContaining({
          kind: 'reject',
          operation: 'reject_memory_candidate_entry',
          params: expect.objectContaining({ id: 'candidate:review' }),
          requires_mutation_ledger: true,
        }),
        expect.objectContaining({
          kind: 'restore',
          operation: 'restore_lifecycle_memory',
          params: expect.objectContaining({ entity_id: 'assertion:stale' }),
          requires_mutation_ledger: true,
        }),
        expect.objectContaining({
          kind: 'purge',
          operation: 'plan_lifecycle_purge',
          target_kind: 'lifecycle_scope',
          target_id: 'workspace:default',
          params: expect.objectContaining({
            scope_id: 'workspace:default',
            limit: 1,
          }),
          requires_mutation_ledger: true,
        }),
      ]));
      expect(report.actions).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          operation: 'reject_memory_candidate_entry',
          params: expect.objectContaining({ id: 'candidate:captured' }),
        }),
        expect.objectContaining({
          operation: 'promote_memory_candidate_entry',
          params: expect.objectContaining({ id: 'candidate:queued' }),
        }),
      ]));

      const operationContext = { engine, config: {} as any, logger: console, dryRun: false };
      const pauseAction = report.actions.find((action) =>
        action.operation === 'pause_source_processing' && action.target_id === 'source:slack'
      );
      const revokeAction = report.actions.find((action) =>
        action.operation === 'revoke_source_consent' && action.target_id === 'source:slack'
      );
      const rerunAction = report.actions.find((action) =>
        action.operation === 'rerun_memory_job' && action.target_id === 'job:runner-failed'
      );
      expect(pauseAction).toBeDefined();
      expect(revokeAction).toBeDefined();
      expect(rerunAction).toBeDefined();
      expect(report.actions).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          operation: 'rerun_memory_job',
          target_id: 'runner-job:durable-degraded',
        }),
      ]));

      const pauseResult = await operationsByName[pauseAction!.operation].handler(operationContext, {
        ...pauseAction!.params,
        now,
      });
      expect(pauseResult).toMatchObject({
        action: 'pause_source_processing',
        source_id: 'source:slack',
        status: 'applied',
        mutation_event: expect.objectContaining({
          operation: 'pause_source_processing',
          target_kind: 'source_record',
          target_id: 'source:slack',
          result: 'applied',
        }),
      });
      const pausedSource = db.query(`
        SELECT enabled, paused_at, consent_state
        FROM sources
        WHERE id = 'source:slack'
      `).get() as { enabled: number; paused_at: string; consent_state: string };
      expect(pausedSource).toEqual({
        enabled: 0,
        paused_at: now,
        consent_state: 'granted',
      });

      const revokeResult = await operationsByName[revokeAction!.operation].handler(operationContext, {
        ...revokeAction!.params,
        now,
      });
      expect(revokeResult).toMatchObject({
        action: 'revoke_source_consent',
        source_id: 'source:slack',
        status: 'applied',
        mutation_event: expect.objectContaining({
          operation: 'revoke_source_consent',
          target_kind: 'source_record',
          target_id: 'source:slack',
          result: 'applied',
        }),
      });
      const revokedSource = db.query(`
        SELECT enabled, paused_at, consent_state
        FROM sources
        WHERE id = 'source:slack'
      `).get() as { enabled: number; paused_at: string; consent_state: string };
      expect(revokedSource).toEqual({
        enabled: 0,
        paused_at: now,
        consent_state: 'revoked',
      });
      const sourceStatusEvents = db.query(`
        SELECT event_type, previous_state, next_state, actor_ref, reason
        FROM source_status_events
        WHERE source_id = 'source:slack'
        ORDER BY created_at ASC, id ASC
      `).all() as Array<{ event_type: string; previous_state: string | null; next_state: string; actor_ref: string; reason: string }>;
      expect(sourceStatusEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event_type: 'paused',
          previous_state: 'enabled',
          next_state: 'paused',
          actor_ref: 'mbrain:memory-report',
        }),
        expect.objectContaining({
          event_type: 'revoked',
          previous_state: 'granted',
          next_state: 'revoked',
          actor_ref: 'mbrain:memory-report',
        }),
      ]));
      expect(() => db.query(`
        UPDATE source_status_events
        SET reason = 'mutated'
        WHERE source_id = 'source:slack'
      `).run()).toThrow(/append-only/);

      const rerunResult = await operationsByName[rerunAction!.operation].handler(operationContext, {
        ...rerunAction!.params,
        now,
      });
      expect(rerunResult).toMatchObject({
        action: 'rerun_memory_job',
        job_id: 'job:runner-failed',
        status: 'waiting',
        mutation_event: expect.objectContaining({
          operation: 'rerun_memory_job',
          target_kind: 'procedure',
          target_id: 'job:runner-failed',
          result: 'applied',
        }),
      });
      const rerunJob = db.query(`
        SELECT status, failure_class, last_error, next_run_at
        FROM memory_jobs
        WHERE id = 'job:runner-failed'
      `).get() as { status: string; failure_class: string | null; last_error: string | null; next_run_at: string };
      expect(rerunJob).toEqual({
        status: 'waiting',
        failure_class: null,
        last_error: null,
        next_run_at: now,
      });
      const jobEvents = db.query(`
        SELECT event_type, worker_id, metadata_json
        FROM memory_job_events
        WHERE job_id = 'job:runner-failed'
      `).all() as Array<{ event_type: string; worker_id: string | null; metadata_json: string }>;
      expect(jobEvents).toEqual([
        expect.objectContaining({
          event_type: 'rerun_requested',
          worker_id: 'mbrain:memory-report',
        }),
      ]);
      expect(JSON.parse(jobEvents[0].metadata_json)).toMatchObject({
        reason: expect.stringContaining('memory review report rerun action'),
      });

      const ledgerEvents = await engine.listMemoryMutationEvents({
        target_id: 'source:slack',
        target_kind: 'source_record',
      });
      expect(ledgerEvents.map((event) => event.operation)).toEqual(expect.arrayContaining([
        'pause_source_processing',
        'revoke_source_consent',
      ]));
      const jobLedgerEvents = await engine.listMemoryMutationEvents({
        target_id: 'job:runner-failed',
        target_kind: 'procedure',
      });
      expect(jobLedgerEvents.map((event) => event.operation)).toContain('rerun_memory_job');

      const sourceLedgerCount = ledgerEvents.length;
      await expect(operationsByName[pauseAction!.operation].handler(operationContext, {
        ...pauseAction!.params,
        now,
      })).rejects.toThrow(/source_id must refer to an enabled source/);
      await expect(operationsByName[revokeAction!.operation].handler(operationContext, {
        ...revokeAction!.params,
        now,
      })).rejects.toThrow(/source_id must refer to a source whose consent is not already revoked/);
      await expect(operationsByName[rerunAction!.operation].handler(operationContext, {
        ...rerunAction!.params,
        now,
      })).rejects.toThrow(/job_id must refer to a failed or dead job/);
      expect((await engine.listMemoryMutationEvents({
        target_id: 'source:slack',
        target_kind: 'source_record',
      })).length).toBe(sourceLedgerCount);
      expect((await engine.listMemoryMutationEvents({
        target_id: 'job:runner-failed',
        target_kind: 'procedure',
      })).length).toBe(jobLedgerEvents.length);
    } finally {
      await engine.disconnect();
    }
  });

  test('report action operations mutate PGLite runtime state and reject duplicate applied ledger writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-report-pglite-'));
    tempPaths.push(dir);
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    try {
      const db = (engine as any).db;
      await db.query(`
        INSERT INTO sources (id, kind, display_name, consent_state, enabled, created_at, updated_at)
        VALUES ('source:slack', 'slack', 'Slack', 'granted', true, $1, $1)
      `, [now]);
      await db.query(`
        INSERT INTO memory_jobs (
          id, name, queue, status, priority, payload_json, progress_json, max_attempts,
          attempts_started, attempts_finished, backoff_type, backoff_delay_ms,
          next_run_at, failure_class, last_error, created_at, updated_at
        ) VALUES (
          'job:runner-failed', 'runner:forgetting-review', 'maintenance', 'dead', 0,
          '{"task_type":"forgetting_review"}'::jsonb, '{}'::jsonb, 1,
          1, 1, 'none', 0, $1, 'runner_unavailable', 'runner unavailable', $1, $1
        )
      `, [now]);

      const operationContext = { engine, config: {} as any, logger: console, dryRun: false };
      await operationsByName.pause_source_processing.handler(operationContext, {
        source_id: 'source:slack',
        reason: 'pglite report action smoke',
        actor_ref: 'mbrain:memory-report',
        now,
      });
      await operationsByName.revoke_source_consent.handler(operationContext, {
        source_id: 'source:slack',
        reason: 'pglite report action smoke',
        actor_ref: 'mbrain:memory-report',
        now,
      });
      await operationsByName.rerun_memory_job.handler(operationContext, {
        job_id: 'job:runner-failed',
        reason: 'pglite report action smoke',
        requested_by: 'mbrain:memory-report',
        now,
      });

      const source = await db.query(`
        SELECT enabled, paused_at, consent_state
        FROM sources
        WHERE id = 'source:slack'
      `);
      expect(source.rows).toEqual([{
        enabled: false,
        paused_at: new Date(now),
        consent_state: 'revoked',
      }]);
      await expect(db.query(`
        DELETE FROM source_status_events
        WHERE source_id = 'source:slack'
      `)).rejects.toThrow(/append-only/);
      const job = await db.query(`
        SELECT status, failure_class, last_error
        FROM memory_jobs
        WHERE id = 'job:runner-failed'
      `);
      expect(job.rows).toEqual([{ status: 'waiting', failure_class: null, last_error: null }]);

      const sourceLedgerEvents = await engine.listMemoryMutationEvents({
        target_id: 'source:slack',
        target_kind: 'source_record',
      });
      const jobLedgerEvents = await engine.listMemoryMutationEvents({
        target_id: 'job:runner-failed',
        target_kind: 'procedure',
      });
      expect(sourceLedgerEvents.map((event) => event.operation)).toEqual(expect.arrayContaining([
        'pause_source_processing',
        'revoke_source_consent',
      ]));
      expect(jobLedgerEvents.map((event) => event.operation)).toContain('rerun_memory_job');

      await expect(operationsByName.pause_source_processing.handler(operationContext, {
        source_id: 'source:slack',
        reason: 'duplicate pglite report action',
        actor_ref: 'mbrain:memory-report',
        now,
      })).rejects.toThrow(/source_id must refer to an enabled source/);
      await expect(operationsByName.rerun_memory_job.handler(operationContext, {
        job_id: 'job:runner-failed',
        reason: 'duplicate pglite report action',
        requested_by: 'mbrain:memory-report',
        now,
      })).rejects.toThrow(/job_id must refer to a failed or dead job/);
      expect((await engine.listMemoryMutationEvents({
        target_id: 'source:slack',
        target_kind: 'source_record',
      })).length).toBe(sourceLedgerEvents.length);
      expect((await engine.listMemoryMutationEvents({
        target_id: 'job:runner-failed',
        target_kind: 'procedure',
      })).length).toBe(jobLedgerEvents.length);
    } finally {
      await engine.disconnect();
    }
  });

  test('warns at the top of the report when the review and staging backlog exceeds the pressure threshold', () => {
    const report = buildMemoryReviewReport({
      scope_id: 'workspace:default',
      generated_at: now,
      review_items: Array.from({ length: MEMORY_INBOX_REVIEW_PRESSURE_THRESHOLD }, (_, index) => ({
        id: `candidate:${index}`,
        review_type: index === 0 ? 'candidate_staging' : 'candidate',
        summary: index === 0 ? `Candidate ${index} needs staging` : `Staged candidate ${index}`,
        severity: 'medium' as const,
      })),
    });

    const formatted = formatMemoryReviewReport(report);
    const warningIndex = formatted.indexOf('WARNING: review backlog pressure');
    expect(warningIndex).toBeGreaterThan(-1);
    expect(formatted.slice(0, warningIndex)).not.toContain('Summary');
    expect(formatted).toContain(`${MEMORY_INBOX_REVIEW_PRESSURE_THRESHOLD} candidates need review or staging`);
    expect(formatted).toContain('Stage candidate items first, then promote, reject, or supersede staged candidates.');
    expect(formatted).not.toContain('candidates are staged for review');
  });

  test('emits no backlog warning below the pressure threshold', () => {
    const report = buildMemoryReviewReport({
      scope_id: 'workspace:default',
      generated_at: now,
      review_items: [
        {
          id: 'candidate:solo',
          review_type: 'candidate',
          summary: 'Single staged candidate',
          severity: 'low',
        },
      ],
    });

    expect(formatMemoryReviewReport(report)).not.toContain('WARNING: review backlog pressure');
  });
});

function canonicalTargetProposal(
  id: string,
  overrides: Partial<NonNullable<Parameters<typeof buildMemoryReviewReport>[0]['canonical_target_proposals']>[number]> = {},
): NonNullable<Parameters<typeof buildMemoryReviewReport>[0]['canonical_target_proposals']>[number] {
  return {
    id,
    source_candidate_id: 'candidate:source',
    linked_candidate_ids: ['candidate:source'],
    status: 'proposed',
    proposed_slug: 'systems/example-target',
    proposed_title: 'Example Target',
    status_reason: null,
    stub_patch_candidate_id: null,
    stub_patch_state: null,
    bound_candidate_ids: [],
    ...overrides,
  };
}
