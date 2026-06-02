import { describe, expect, test } from 'bun:test';
import { createMaintenanceRuntimeService } from '../src/core/services/maintenance-runtime-service.ts';
import {
  DREAM_CYCLE_PHASE_FAMILIES,
  runDreamCycle,
} from '../src/core/services/dream-cycle-runner-service.ts';

describe('dream cycle phase runner', () => {
  test('phase registry order is stable and landed phase families no longer report unavailable owner phases', async () => {
    expect(DREAM_CYCLE_PHASE_FAMILIES.map((entry) => entry.family)).toEqual([
      'source_status',
      'source_sync',
      'raw_ingest',
      'safety_scan',
      'claim_extraction',
      'assertion_resolution',
      'canonical_write',
      'consolidation',
      'contradiction_review',
      'forgetting_review',
      'projection_reconcile',
      'embedding_refresh',
      'context_refresh',
      'daily_report',
      'auto_promote',
    ]);

    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
    });

    expect(result.phases.map((phase) => phase.family)).toEqual(
      DREAM_CYCLE_PHASE_FAMILIES.map((entry) => entry.family),
    );
    for (const phase of result.phases) {
      expect(phase.skip_reason).not.toBe('phase_not_available');
    }
    expect(result.phases.find((phase) => phase.family === 'source_sync')).toMatchObject({
      status: 'warn',
      owner_phase: 'Phase 11',
      counts: { connector_accounts: 0, unhealthy_connectors: 0, count_errors: 2 },
      next_recommended_action: 'Inspect dream-cycle read model errors before claiming phase coverage.',
    });
    expect(result.phases.find((phase) => phase.family === 'daily_report')).toMatchObject({
      status: 'warn',
      owner_phase: 'Phase 12',
      counts: { failed_jobs: 0, failed_runner_jobs: 0, count_errors: 2 },
      next_recommended_action: 'Inspect dream-cycle read model errors before claiming phase coverage.',
    });
    expect(result.phases.find((phase) => phase.family === 'forgetting_review')).toMatchObject({
      status: 'skipped',
      skip_reason: 'runner_unavailable',
      owner_phase: 'Phase 08',
      next_recommended_action: 'Configure lifecycle forgetting service before enabling forgetting review.',
    });
  });

  test('dry-run emits anti-loop markers and does not mutate canonical memory', async () => {
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
    });

    expect(result.mode).toBe('dry_run');
    expect(result.canonical_write_allowed).toBe(false);
    expect(result.llm_or_runner_used).toBe(false);
    expect(result.self_consumption_guard).toEqual({
      generated_by: 'dream_cycle',
      anti_loop_marker: 'mbrain:dream-cycle-output:v1',
      raw_source_ingest_allowed: false,
    });
    expect(result.phases.every((phase) => phase.canonical_mutations === 0)).toBe(true);
  });

  test('cycle lock prevents concurrent mutating dream runs', async () => {
    const runtime = createMaintenanceRuntimeService({ now: () => '2026-05-21T10:00:00.000Z' });
    await runtime.acquireCycleLock({
      cycle_name: 'dream_cycle:workspace:default',
      holder_pid: 10,
      holder_host: 'host-a',
      holder_kind: 'daemon',
      ttl_ms: 60_000,
    });

    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: false,
      write_candidates: true,
    }, {
      runtime,
      holder: {
        holder_pid: 11,
        holder_host: 'host-a',
        holder_kind: 'manual',
      },
    });

    expect(result.status).toBe('failed');
    expect(result.cycle_lock).toMatchObject({
      status: 'busy',
      current_holder: { holder_kind: 'daemon' },
    });
    expect(result.phases).toEqual([]);
  });

  test('mutating dream runs fail closed when no cycle-lock runtime is supplied', async () => {
    let readCount = 0;
    const result = await runDreamCycle({
      listMemoryCandidateEntries: async () => {
        readCount += 1;
        return [];
      },
    } as any, {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: false,
      write_candidates: true,
    });

    expect(result.status).toBe('failed');
    expect(result.cycle_lock).toMatchObject({
      status: 'missing_runtime',
      message: 'Mutating dream runs require a maintenance runtime cycle lock.',
    });
    expect(result.phases).toEqual([]);
    expect(readCount).toBe(0);
  });

  test('failed phase and policy denial produce structured phase results', async () => {
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
    }, {
      phaseHandlers: {
        source_status: async () => ({
          status: 'warn',
          counts: { denied: 1 },
          policy_denials: [{ code: 'prompt_injection_quarantine', message: 'blocked unsafe source' }],
          next_recommended_action: 'Review quarantined source policy.',
        }),
        consolidation: async () => {
          throw new Error('simulated consolidation failure');
        },
      },
    });

    expect(result.phases.find((phase) => phase.family === 'source_status')).toMatchObject({
      status: 'warn',
      policy_denials: [{ code: 'prompt_injection_quarantine', message: 'blocked unsafe source' }],
      next_recommended_action: 'Review quarantined source policy.',
    });
    expect(result.phases.find((phase) => phase.family === 'consolidation')).toMatchObject({
      status: 'failed',
      errors: ['simulated consolidation failure'],
      next_recommended_action: 'Inspect phase error and retry dream cycle after repair.',
    });
  });

  test('landed runner-backed families report runner availability instead of owner unavailability', async () => {
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
      allow_local_runner: false,
    });

    expect(result.phases.find((phase) => phase.family === 'claim_extraction')).toMatchObject({
      status: 'skipped',
      skip_reason: 'runner_unavailable',
      llm_or_runner_used: false,
    });
  });

  test('auto-promote phase forces dry-run unless write_candidates is enabled', async () => {
    const calls: any[] = [];
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: false,
      write_candidates: false,
      allow_local_runner: true,
    }, {
      autoPromote: {
        run: async (input) => {
          calls.push(input);
          return { counts: { selected_low_risk: 1 } };
        },
      },
    });

    expect(calls[0]).toMatchObject({ dry_run: true });
    expect(result.llm_or_runner_used).toBe(true);
    expect(result.phases.find((phase) => phase.family === 'auto_promote')).toMatchObject({
      status: 'warn',
      llm_or_runner_used: true,
    });
  });

  test('read-only landed phases warn only on actionable counts', async () => {
    const engine = {
      sql: {
        unsafe: async (statement: string) => {
          if (statement.includes('FROM sources WHERE paused_at IS NOT NULL')) return [{ count: 0 }];
          if (statement.includes('FROM sources')) return [{ count: 3 }];
          if (statement.includes('FROM connector_accounts')) return [{ count: 2 }];
          if (statement.includes('FROM connector_sync_states')) return [{ count: 1 }];
          return [{ count: 0 }];
        },
      },
    } as any;

    const result = await runDreamCycle(engine, {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
    });

    expect(result.phases.find((phase) => phase.family === 'source_status')).toMatchObject({
      status: 'ok',
      counts: { sources: 3, paused_sources: 0 },
      next_recommended_action: null,
    });
    expect(result.phases.find((phase) => phase.family === 'source_sync')).toMatchObject({
      status: 'warn',
      counts: { connector_accounts: 2, unhealthy_connectors: 1 },
      next_recommended_action: 'Review connector sync health.',
    });
  });

  test('read-only landed phases surface count errors and do not claim runner usage', async () => {
    const engine = {
      sql: {
        unsafe: async (statement: string) => {
          if (statement.includes('FROM extracted_claims')) {
            throw new Error('relation "extracted_claims" does not exist');
          }
          return [{ count: 0 }];
        },
      },
    } as any;

    const result = await runDreamCycle(engine, {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
      allow_local_runner: true,
    });

    expect(result.llm_or_runner_used).toBe(false);
    expect(result.phases.find((phase) => phase.family === 'claim_extraction')).toMatchObject({
      status: 'warn',
      counts: { pending_claims: 0, count_errors: 1 },
      errors: ['extracted_claims: relation "extracted_claims" does not exist'],
      next_recommended_action: 'Inspect dream-cycle read model errors before claiming phase coverage.',
      llm_or_runner_used: false,
    });
  });

  test('read-only landed phases warn when no read-model query handle is available', async () => {
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
    });

    expect(result.phases.find((phase) => phase.family === 'source_status')).toMatchObject({
      status: 'warn',
      counts: { sources: 0, paused_sources: 0, count_errors: 2 },
      errors: [
        'sources: read model query interface is unavailable',
        'sources: read model query interface is unavailable',
      ],
      next_recommended_action: 'Inspect dream-cycle read model errors before claiming phase coverage.',
      llm_or_runner_used: false,
    });
  });

  test('read-only landed phases query Postgres-style _sql handles and surface health errors', async () => {
    const queries: string[] = [];
    const engine = {
      _sql: {
        unsafe: async (statement: string) => {
          queries.push(statement);
          if (statement.includes('FROM sources WHERE paused_at IS NOT NULL')) return [{ count: 0 }];
          if (statement.includes('FROM sources')) return [{ count: 4 }];
          return [{ count: 0 }];
        },
      },
      getHealth: async () => {
        throw new Error('health unavailable');
      },
    } as any;

    const result = await runDreamCycle(engine, {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
    });

    expect(queries.some((query) => query.includes('FROM sources'))).toBe(true);
    expect(result.phases.find((phase) => phase.family === 'source_status')).toMatchObject({
      status: 'ok',
      counts: { sources: 4, paused_sources: 0 },
    });
    expect(result.phases.find((phase) => phase.family === 'embedding_refresh')).toMatchObject({
      status: 'warn',
      counts: { missing_embeddings: 0, count_errors: 1 },
      errors: ['engine.getHealth: health unavailable'],
      next_recommended_action: 'Inspect dream-cycle read model errors before claiming phase coverage.',
    });
  });

  test('implemented runner-backed phase can degrade when runner is unavailable', async () => {
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
      allow_local_runner: false,
    }, {
      phaseHandlers: {
        claim_extraction: async ({ input }) => input.allow_local_runner
          ? { status: 'ok', llm_or_runner_used: true }
          : {
              status: 'skipped',
              skip_reason: 'runner_unavailable',
              next_recommended_action: 'Enable local runner policy before claim extraction.',
              llm_or_runner_used: false,
            },
      },
    });

    expect(result.phases.find((phase) => phase.family === 'claim_extraction')).toMatchObject({
      status: 'skipped',
      skip_reason: 'runner_unavailable',
      next_recommended_action: 'Enable local runner policy before claim extraction.',
      llm_or_runner_used: false,
    });
  });

  test('forgetting review uses lifecycle service for report and purge planning', async () => {
    const calls: string[] = [];
    const lifecycleForgetting = {
      runDueLifecycleTransitions: async () => {
        calls.push('transitions');
        return { transitioned: [{ state: { entity_id: 'assertion:stale' } }], skipped: [] };
      },
      buildDailyReport: async () => {
        calls.push('report');
        return {
          generated_at: '2026-05-21T10:00:00.000Z',
          purge_candidate_count: 2,
          restore_window_count: 1,
          summary_lines: [],
          purge_candidates: [],
          restore_windows: [],
        };
      },
      planPurgeCandidates: async () => {
        calls.push('plan');
        return {
          plan: {
            id: 'purge-plan:dream',
            scope_id: 'workspace:default',
            status: 'draft',
            reason: 'dream forgetting review',
            requested_by: 'mbrain:dream_cycle',
            review_reason: null,
            created_at: '2026-05-21T10:00:00.000Z',
            reviewed_at: null,
            applied_at: null,
          },
          items: [
            { id: 'purge-plan-item:1' },
            { id: 'purge-plan-item:2' },
          ],
        };
      },
    } as any;

    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: false,
      write_candidates: true,
    }, {
      runtime: createMaintenanceRuntimeService({ now: () => '2026-05-21T10:00:00.000Z' }),
      lifecycleForgetting,
    });

    expect(result.phases.find((phase) => phase.family === 'forgetting_review')).toMatchObject({
      status: 'warn',
      counts: {
        purge_candidates: 2,
        restore_windows: 1,
        purge_plan_items: 2,
        lifecycle_transitions: 1,
      },
      job_ids: ['purge-plan:dream'],
      canonical_mutations: 0,
      llm_or_runner_used: false,
    });
    expect(calls).toEqual(['transitions', 'report', 'plan']);
  });
});

function stubEngine() {
  return {
    listMemoryCandidateEntries: async () => [],
  } as any;
}
