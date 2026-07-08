import { describe, expect, test } from 'bun:test';
import {
  DREAM_CYCLE_PHASE_FAMILIES,
  runDreamCycle,
} from '../src/core/services/dream-cycle-runner-service.ts';
import { createMaintenanceRuntimeService } from '../src/core/services/maintenance-runtime-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

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
      'recompile',
      'daily_report',
      'auto_promote',
      'anticipation',
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
      counts: { failed_jobs: 0, failed_runner_jobs: 0, stuck_active_jobs: 0, count_errors: 3 },
      next_recommended_action: 'Inspect dream-cycle read model errors before claiming phase coverage.',
    });
    expect(result.phases.find((phase) => phase.family === 'forgetting_review')).toMatchObject({
      status: 'skipped',
      skip_reason: 'runner_unavailable',
      owner_phase: 'Phase 08',
      next_recommended_action: 'Configure lifecycle forgetting service before enabling forgetting review.',
    });
    expect(result.phases.find((phase) => phase.family === 'recompile')).toMatchObject({
      status: 'skipped',
      skip_reason: 'flag_disabled',
      owner_phase: 'Phase 07',
      next_recommended_action: 'Enable maintenance.governed_recompile_enabled before running governed recompile.',
    });
    expect(result.phases.find((phase) => phase.family === 'anticipation')).toMatchObject({
      status: 'skipped',
      skip_reason: 'flag_disabled',
      owner_phase: 'Phase 13',
      next_recommended_action: 'Enable dream.anticipation_enabled before precomputing next-session read plans.',
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
      same_cycle_candidate_promotion_allowed: false,
      guarded_candidate_ids: [],
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

  test('mutating dream runs require a replay canary before phase work', async () => {
    let readCount = 0;
    const result = await runDreamCycle({
      listMemoryCandidateEntries: async () => {
        readCount += 1;
        return [];
      },
    } as any, {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
    }, {
      runtime: createMaintenanceRuntimeService({ now: () => '2026-06-06T00:00:00.000Z' }),
    });

    expect(result.status).toBe('failed');
    expect(result.guardrails.replay_canary).toMatchObject({
      status: 'not_configured',
      required: true,
    });
    expect(result.phases).toEqual([]);
    expect(readCount).toBe(0);
  });

  test('mutating dream runs renew the same-holder cycle lock before mutating phases', async () => {
    const runtime = createMaintenanceRuntimeService({ now: () => '2026-06-06T00:00:00.000Z' });
    const acquireCalls: any[] = [];
    const wrappedRuntime = {
      acquireCycleLock: async (input: any) => {
        acquireCalls.push(input);
        return runtime.acquireCycleLock(input);
      },
      releaseCycleLock: (input: any) => runtime.releaseCycleLock(input),
    };

    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
    }, {
      runtime: wrappedRuntime,
      replayCanary: passingReplayCanary(),
    });

    expect(result.guardrails.lock_renewal).toMatchObject({
      status: 'renewed',
      renewal_count: 2,
    });
    expect(acquireCalls).toHaveLength(3);
    expect(acquireCalls.map((call) => call.cycle_name)).toEqual([
      'dream_cycle:workspace:default',
      'dream_cycle:workspace:default',
      'dream_cycle:workspace:default',
    ]);
  });

  test('lock renewal failure aborts before invoking the guarded phase', async () => {
    const runtime = createMaintenanceRuntimeService({ now: () => '2026-06-06T00:00:00.000Z' });
    let acquireCount = 0;
    let consolidationCalls = 0;
    const wrappedRuntime = {
      acquireCycleLock: async (input: any) => {
        acquireCount += 1;
        if (acquireCount > 1) {
          return {
            status: 'busy' as const,
            current_holder: {
              holder_pid: 99,
              holder_host: 'host-b',
              holder_kind: 'daemon',
              ttl_expires_at: '2026-06-06T00:01:00.000Z',
            },
          };
        }
        return runtime.acquireCycleLock(input);
      },
      releaseCycleLock: (input: any) => runtime.releaseCycleLock(input),
    };

    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
    }, {
      runtime: wrappedRuntime,
      replayCanary: passingReplayCanary(),
      phaseHandlers: {
        consolidation: async () => {
          consolidationCalls += 1;
          return { status: 'ok' };
        },
      },
    });

    expect(result.status).toBe('failed');
    expect(result.guardrails.lock_renewal).toMatchObject({
      status: 'aborted',
      renewal_count: 0,
      reason_codes: ['cycle_lock_renewal_busy'],
    });
    expect(result.phases.find((phase) => phase.family === 'consolidation')).toMatchObject({
      status: 'failed',
      errors: ['Dream cycle lock renewal failed before consolidation.'],
    });
    expect(consolidationCalls).toBe(0);
  });

  test('lock renewal exception includes sanitized diagnostic details in guardrails', async () => {
    const runtime = createMaintenanceRuntimeService({ now: () => '2026-06-06T00:00:00.000Z' });
    let acquireCount = 0;
    const renewalError = new Error(
      'renewal failed for postgresql://runner:super-secret@localhost:5432/mbrain with sk-test1234567890 and github_pat_abcdefghijklmnopqrstuvwxyz\nretry later',
    );
    renewalError.stack = `Error: renewal failed for postgresql://runner:super-secret@localhost:5432/mbrain and aws secret access key=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN\n-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----\n${
      '    at renewDreamLockBeforePhase (/repo/src/core/services/dream-cycle-runner-service.ts:830:11)\n'.repeat(40)
    }`;
    const wrappedRuntime = {
      acquireCycleLock: async (input: any) => {
        acquireCount += 1;
        if (acquireCount > 1) {
          throw renewalError;
        }
        return runtime.acquireCycleLock(input);
      },
      releaseCycleLock: (input: any) => runtime.releaseCycleLock(input),
    };

    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
    }, {
      runtime: wrappedRuntime,
      replayCanary: passingReplayCanary(),
    });

    expect(result.status).toBe('failed');
    expect(result.guardrails.lock_renewal).toMatchObject({
      status: 'aborted',
      renewal_count: 0,
      reason_codes: ['cycle_lock_renewal_error'],
      last_error: {
        message: 'renewal failed for postgresql://[REDACTED:database_connection_string]@localhost:5432/mbrain with [REDACTED:openai_api_key] and [REDACTED:github_token] retry later',
      },
    });
    const renewalStack = result.guardrails.lock_renewal.last_error?.stack;
    if (!renewalStack) throw new Error('Expected lock renewal diagnostic stack');
    expect(renewalStack).toContain(
      'Error: renewal failed for postgresql://[REDACTED:database_connection_string]@localhost:5432/mbrain',
    );
    expect(renewalStack).toContain('aws secret access key=[REDACTED:aws_secret_access_key]');
    expect(renewalStack).toContain('[REDACTED:pem_private_key]');
    expect(renewalStack).not.toContain('super-secret');
    expect(renewalStack).not.toContain('secret-key-material');
    expect(renewalStack).toContain('...[truncated]');
    expect(renewalStack.length).toBeLessThanOrEqual(1040);
  });

  test('failed phase and policy denial produce structured phase results', async () => {
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: false,
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

  test('rejects non-ISO now input before daily report SQL is built', async () => {
    await expect(runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: "2026-05-21T10:00:00.000Z'; DROP TABLE memory_jobs; --",
      dry_run: true,
    })).rejects.toThrow('now must be a valid ISO datetime string');
  });

  test('daily report stuck-active count binds now as a SQL parameter', async () => {
    const calls: Array<{ query: string; params: unknown[] }> = [];
    const now = '2026-05-21T10:00:00.000Z';
    await runDreamCycle({
      listMemoryCandidateEntries: async () => [],
      sql: {
        unsafe: async (query: string, params: unknown[] = []) => {
          calls.push({ query, params });
          return [{ count: 0 }];
        },
      },
    } as any, {
      scope_id: 'workspace:default',
      now,
      dry_run: true,
    });

    const stuckActiveCount = calls.find((call) =>
      call.query.includes('memory_jobs')
      && call.query.includes('lock_expires_at')
    );
    expect(stuckActiveCount).toBeDefined();
    expect(stuckActiveCount?.query).not.toContain(now);
    expect(stuckActiveCount?.params).toEqual([now]);
  });

  test('auto-promote phase forces dry-run unless write_candidates is enabled', async () => {
    const calls: any[] = [];
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: false,
      write_candidates: false,
      allow_local_runner: true,
      limit: 7,
    }, {
      autoPromote: {
        run: async (input) => {
          calls.push(input);
          return { counts: { selected_low_risk: 1 } };
        },
      },
    });

    expect(calls[0]).toMatchObject({ dry_run: true, limit: 7 });
    expect(result.llm_or_runner_used).toBe(true);
    expect(result.phases.find((phase) => phase.family === 'auto_promote')).toMatchObject({
      status: 'warn',
      llm_or_runner_used: true,
    });
  });

  test('auto-promote is dry-run unless apply_auto_promote is explicitly enabled', async () => {
    const calls: any[] = [];
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
      apply_auto_promote: false,
      allow_local_runner: true,
    } as any, {
      runtime: createMaintenanceRuntimeService({ now: () => '2026-06-06T00:00:00.000Z' }),
      replayCanary: passingReplayCanary(),
      autoPromote: {
        run: async (input: any) => {
          calls.push(input);
          return { counts: { selected_low_risk: 1, canonical_writes: 0 } };
        },
      },
    });

    expect(calls[0]).toMatchObject({
      dry_run: true,
      allow_canonical_page_writes: false,
    });
    expect(result.phases.find((phase) => phase.family === 'auto_promote')).toMatchObject({
      status: 'warn',
    });
  });

  test('auto-promote receives canonical write permission only when explicitly allowed', async () => {
    const calls: any[] = [];
    await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
      apply_auto_promote: true,
      allow_canonical_page_writes: true,
      allow_local_runner: true,
      max_runner_calls: 2,
      time_budget_ms: 1000,
      max_candidates_per_cycle: 4,
    } as any, {
      runtime: createMaintenanceRuntimeService({ now: () => '2026-06-06T00:00:00.000Z' }),
      replayCanary: passingReplayCanary(),
      autoPromote: {
        run: async (input: any) => {
          calls.push(input);
          return { counts: {} };
        },
      },
    });

    expect(calls[0]).toMatchObject({
      dry_run: false,
      allow_canonical_page_writes: true,
      max_runner_calls: 2,
      time_budget_ms: 1000,
      limit: 4,
    });
  });

  test('failed replay canary blocks auto-promote apply before runner use', async () => {
    const calls: any[] = [];
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
      apply_auto_promote: true,
      allow_canonical_page_writes: true,
      allow_local_runner: true,
    } as any, {
      runtime: createMaintenanceRuntimeService({ now: () => '2026-06-06T00:00:00.000Z' }),
      replayCanary: {
        run: async () => ({
          status: 'failed',
          reason_codes: ['replay_regression'],
        }),
      },
      autoPromote: {
        run: async (input: any) => {
          calls.push(input);
          return { counts: { canonical_writes: 1 } };
        },
      },
    });

    expect(result.status).toBe('failed');
    expect(result.guardrails.replay_canary).toMatchObject({
      status: 'failed',
      required: true,
      reason_codes: ['replay_regression'],
    });
    expect(calls).toEqual([]);
  });

  test('auto-promote excludes candidates generated earlier in the same dream cycle', async () => {
    const calls: any[] = [];
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
      apply_auto_promote: true,
      allow_local_runner: true,
      max_candidates_per_cycle: 4,
    } as any, {
      runtime: createMaintenanceRuntimeService({ now: () => '2026-06-06T00:00:00.000Z' }),
      replayCanary: passingReplayCanary(),
      phaseHandlers: {
        consolidation: async (context) => {
          context.cycle.dream_generated_candidate_ids.add('candidate:dream-this-cycle');
          return {
            status: 'warn',
            counts: { suggestions: 1 },
          };
        },
      },
      autoPromote: {
        run: async (input: any) => {
          calls.push(input);
          return { counts: { excluded: input.exclude_candidate_ids.length } };
        },
      },
    });

    expect(calls[0]).toMatchObject({
      dry_run: false,
      exclude_candidate_ids: ['candidate:dream-this-cycle'],
      limit: 4,
    });
    expect(result.phases.find((phase) => phase.family === 'auto_promote')).toMatchObject({
      status: 'warn',
      counts: { excluded: 1 },
    });
  });

  test('default consolidation adds created dream candidate ids to the same-cycle guard', async () => {
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: ':memory:' });
    await engine.initSchema();
    try {
      await engine.createMemoryCandidateEntry({
        id: 'candidate:manual-input',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Manual input candidate for dream recap.',
        source_refs: ['Source: dream self-consumption integration test'],
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.9,
        importance_score: 0.5,
        recurrence_score: 0,
        sensitivity: 'work',
        status: 'candidate',
        target_object_type: 'curated_note',
        target_object_id: 'concepts/acme',
      });
      const calls: any[] = [];

      const result = await runDreamCycle(engine, {
        scope_id: 'workspace:default',
        now: '2026-06-06T00:00:00.000Z',
        dry_run: false,
        write_candidates: true,
        apply_auto_promote: true,
        allow_local_runner: true,
        limit: 1,
      } as any, {
        runtime: createMaintenanceRuntimeService({ now: () => '2026-06-06T00:00:00.000Z' }),
        replayCanary: passingReplayCanary(),
        autoPromote: {
          run: async (input: any) => {
            calls.push(input);
            return { counts: { excluded: input.exclude_candidate_ids.length } };
          },
        },
      });

      expect(result.self_consumption_guard.guarded_candidate_ids).toHaveLength(1);
      expect(calls[0].exclude_candidate_ids).toEqual(result.self_consumption_guard.guarded_candidate_ids);
      const guardedCandidate = await engine.getMemoryCandidateEntry(result.self_consumption_guard.guarded_candidate_ids[0]!);
      expect(guardedCandidate).toMatchObject({
        generated_by: 'dream_cycle',
        status: 'candidate',
      });
    } finally {
      await engine.disconnect();
    }
  });

  test('default consolidation flags cross-prefix duplicate page titles', async () => {
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: ':memory:' });
    await engine.initSchema();
    try {
      await engine.putPage('systems/mbrain-agentic-canonical-retrieval.md', {
        type: 'system',
        title: 'MBrain Agentic Canonical Retrieval',
        compiled_truth: 'Canonical retrieval system.',
        timeline: '',
        frontmatter: {},
      });
      await engine.putPage('office/systems/mbrain-agentic-canonical-retrieval.md', {
        type: 'system',
        title: 'MBrain Agentic Canonical Retrieval',
        compiled_truth: 'Duplicate office-prefixed retrieval system.',
        timeline: '',
        frontmatter: {},
      });

      const result = await runDreamCycle(engine, {
        scope_id: 'workspace:default',
        now: '2026-06-06T00:00:00.000Z',
        dry_run: true,
        limit: 10,
      });

      expect(result.phases.find((phase) => phase.family === 'consolidation')).toMatchObject({
        status: 'warn',
        counts: {
          duplicate_page_suggestions: 1,
        },
        source_ids: [
          'duplicate_page:office/systems/mbrain-agentic-canonical-retrieval.md:systems/mbrain-agentic-canonical-retrieval.md',
        ],
      });
    } finally {
      await engine.disconnect();
    }
  });

  test('dry-run suppresses apply and canonical permissions for programmatic callers', async () => {
    const calls: any[] = [];
    await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-06-06T00:00:00.000Z',
      dry_run: true,
      write_candidates: true,
      apply_auto_promote: true,
      allow_canonical_page_writes: true,
      allow_local_runner: true,
    }, {
      autoPromote: {
        run: async (input: any) => {
          calls.push(input);
          return { counts: { selected_low_risk: 1 } };
        },
      },
    });

    expect(calls[0]).toMatchObject({
      dry_run: true,
      allow_canonical_page_writes: false,
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

  test('safety scan treats flagged prompt-injection flags as actionable work', async () => {
    const queries: string[] = [];
    const engine = {
      sql: {
        unsafe: async (statement: string) => {
          queries.push(statement);
          if (statement.includes('FROM prompt_injection_flags')) {
            if (statement.includes("risk IN ('flagged', 'quarantined')")) {
              return [{ count: 2 }];
            }
            return [{ count: 0 }];
          }
          return [{ count: 0 }];
        },
      },
    } as any;

    const result = await runDreamCycle(engine, {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
    });

    const safety = result.phases.find((phase) => phase.family === 'safety_scan');
    expect(queries.some((query) =>
      query.includes('FROM prompt_injection_flags')
      && query.includes("risk IN ('flagged', 'quarantined')")
    )).toBe(true);
    expect(safety).toMatchObject({
      status: 'warn',
      counts: { flagged_or_quarantined_prompt_injection_flags: 2 },
      next_recommended_action: 'Resolve safety flags before runner or LLM access.',
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

  test('recompile phase is runner-gated and reports fake-runner patch candidates without direct canonical mutation', async () => {
    const unavailable = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
      governed_recompile_enabled: true,
    });

    expect(unavailable.phases.find((phase) => phase.family === 'recompile')).toMatchObject({
      status: 'skipped',
      skip_reason: 'runner_unavailable',
      canonical_mutations: 0,
      llm_or_runner_used: false,
    });

    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
      governed_recompile_enabled: true,
    }, {
      governedRecompile: {
        run: async () => ({
          counts: { proposed_patch_candidates: 1 },
          candidate_ids: ['compile-debt-patch:abc123'],
          source_ids: ['systems/compile-debt'],
          summary_lines: ['Created a governed recompile patch candidate.'],
        }),
      },
    });

    expect(result.phases.find((phase) => phase.family === 'recompile')).toMatchObject({
      status: 'warn',
      counts: { proposed_patch_candidates: 1 },
      source_ids: ['systems/compile-debt'],
      canonical_mutations: 0,
      llm_or_runner_used: true,
      next_recommended_action: 'Review governed recompile patch candidates before applying.',
    });
  });

  test('phase timeout marks the phase failed and lets the run return', async () => {
    let observedAbort = false;
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
      phase_timeout_ms: 25,
    }, {
      phaseHandlers: {
        source_status: async (context) => {
          context.input.signal?.addEventListener('abort', () => {
            observedAbort = true;
          }, { once: true });
          return new Promise(() => undefined);
        },
      },
    });

    expect(result.phases.find((phase) => phase.family === 'source_status')).toMatchObject({
      status: 'failed',
      timed_out: true,
      next_recommended_action: 'Inspect the timed-out phase and retry after clearing stuck work.',
    });
    expect(observedAbort).toBe(true);
    expect(result.phases.find((phase) => phase.family === 'daily_report')).toBeDefined();
  });

  test('phase timeout observes a later loser rejection instead of leaking it globally', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await runDreamCycle(stubEngine(), {
        scope_id: 'workspace:default',
        now: '2026-05-21T10:00:00.000Z',
        dry_run: true,
        phase_timeout_ms: 5,
      }, {
        phaseHandlers: {
          source_status: async (context) => new Promise((_, reject) => {
            context.input.signal?.addEventListener('abort', () => {
              setTimeout(() => reject(new Error('late source_status abort rejection')), 1);
            }, { once: true });
          }),
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(result.phases.find((phase) => phase.family === 'source_status')).toMatchObject({
        status: 'failed',
        timed_out: true,
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('daily report phase can persist the memory review report through injected deps', async () => {
    const saves: any[] = [];
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: false,
    }, {
      memoryReport: {
        save: async (input) => {
          saves.push(input);
          return {
            path: '/tmp/brain/reports/memory-review-report/2026-05-21-1000.md',
            counts: {
              review_items: 2,
              open_conflicts: 1,
              incomplete_handoffs: 1,
              failed_jobs: 0,
            },
          };
        },
      },
    });

    expect(saves).toEqual([{
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      limit: undefined,
    }]);
    expect(result.phases.find((phase) => phase.family === 'daily_report')).toMatchObject({
      status: 'warn',
      counts: {
        saved_reports: 1,
        review_items: 2,
        open_conflicts: 1,
        incomplete_handoffs: 1,
      },
      source_ids: ['/tmp/brain/reports/memory-review-report/2026-05-21-1000.md'],
      next_recommended_action: 'Open daily memory report: /tmp/brain/reports/memory-review-report/2026-05-21-1000.md',
    });
  });

  test('daily report phase runs watched question probes before saving the report', async () => {
    const calls: string[] = [];
    const runtime = createMaintenanceRuntimeService({ now: () => '2026-05-21T10:00:00.000Z' });
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: false,
      write_candidates: true,
      limit: 7,
    }, {
      watchedQuestions: {
        run: async (input) => {
          calls.push(`watched:${input.scope_id}:${input.limit}`);
          return {
            probed: 2,
            changed: 1,
            initialized: 1,
            skipped: 1,
            failures: [
              {
                question_id: 'watch:failure',
                question: 'What changed about retrieval?',
                reason: 'embedding provider unavailable',
              },
            ],
            runs: [],
          };
        },
      },
      memoryReport: {
        save: async (input) => {
          calls.push(`report:${input.scope_id}:${input.limit}`);
          return {
            path: '/tmp/brain/reports/memory-review-report/2026-05-21-1000.md',
            counts: {},
          };
        },
      },
      runtime,
      replayCanary: passingReplayCanary(),
    });

    expect(calls).toEqual([
      'watched:workspace:default:7',
      'report:workspace:default:7',
    ]);
    expect(result.phases.find((phase) => phase.family === 'daily_report')).toMatchObject({
      counts: {
        saved_reports: 1,
        watched_questions_probed: 2,
        watched_questions_changed: 1,
        watched_questions_initialized: 1,
        watched_questions_skipped: 1,
        watched_questions_failed: 1,
      },
      errors: [
        'Watched question watch:failure failed: embedding provider unavailable',
      ],
    });
  });

  test('daily report dry-run skips watched question probes and report saves', async () => {
    const calls: string[] = [];
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-05-21T10:00:00.000Z',
      dry_run: true,
      limit: 7,
    }, {
      watchedQuestions: {
        run: async (input) => {
          calls.push(`watched:${input.scope_id}:${input.limit}`);
          return { probed: 2, changed: 1, initialized: 1, skipped: 0, runs: [] };
        },
      },
      memoryReport: {
        save: async (input) => {
          calls.push(`report:${input.scope_id}:${input.limit}`);
          return {
            path: '/tmp/brain/reports/memory-review-report/2026-05-21-1000.md',
            counts: {},
          };
        },
      },
    });

    expect(calls).toEqual([]);
    expect(result.phases.find((phase) => phase.family === 'daily_report')).toMatchObject({
      counts: {
        saved_reports: 0,
      },
    });
    expect(result.phases.find((phase) => phase.family === 'daily_report')?.counts).not.toHaveProperty('watched_questions_probed');
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
      replayCanary: passingReplayCanary(),
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

  test('anticipation phase builds the pack without persisting in dry-run mode', async () => {
    const setConfigCalls: Array<[string, string]> = [];
    const engine = {
      ...stubEngine(),
      setConfig: async (key: string, value: string) => {
        setConfigCalls.push([key, value]);
      },
    };

    const result = await runDreamCycle(engine, {
      scope_id: 'workspace:default',
      now: '2026-07-06T00:00:00.000Z',
      dry_run: true,
      anticipation_enabled: true,
    }, {
      anticipation: {
        build: async () => ({
          generated_at: '2026-07-06T00:00:00.000Z',
          entries: [
            {
              question: 'How does governed writeback work?',
              source: 'watched_question' as const,
              read_plan_selectors: [{ kind: 'page' as const, slug: 'systems/governed-writeback' }],
              token_estimate: 400,
            },
          ],
          candidate_question_count: 1,
          probe_failures: [],
        }),
      },
    });

    expect(result.phases.find((phase) => phase.family === 'anticipation')).toMatchObject({
      status: 'ok',
      counts: {
        candidate_questions: 1,
        pack_entries: 1,
        probe_failures: 0,
        persisted_packs: 0,
      },
      next_recommended_action: 'Run dream cycle in apply mode to persist the anticipation pack.',
      canonical_mutations: 0,
      llm_or_runner_used: false,
    });
    expect(setConfigCalls).toEqual([]);
  });

  test('anticipation phase persists the pack via setConfig in apply mode and reports counts', async () => {
    const setConfigCalls: Array<[string, string]> = [];
    const engine = {
      ...stubEngine(),
      setConfig: async (key: string, value: string) => {
        setConfigCalls.push([key, value]);
      },
    };

    const result = await runDreamCycle(engine, {
      scope_id: 'workspace:default',
      now: '2026-07-06T00:00:00.000Z',
      dry_run: false,
      write_candidates: true,
      anticipation_enabled: true,
    }, {
      runtime: createMaintenanceRuntimeService({ now: () => '2026-07-06T00:00:00.000Z' }),
      replayCanary: passingReplayCanary(),
      anticipation: {
        build: async (input) => ({
          generated_at: input.now,
          entries: [
            {
              question: 'How does governed writeback work?',
              source: 'watched_question' as const,
              read_plan_selectors: [{ kind: 'page' as const, slug: 'systems/governed-writeback' }],
              token_estimate: 400,
            },
            {
              question: 'Harden retrieval ranking',
              source: 'task' as const,
              read_plan_selectors: [{ kind: 'page' as const, slug: 'systems/retrieval' }],
              token_estimate: 400,
            },
          ],
          candidate_question_count: 3,
          probe_failures: [
            { question: 'retrieval pipeline', source: 'recurring_query' as const, reason: 'probe failed' },
          ],
        }),
      },
    });

    expect(result.phases.find((phase) => phase.family === 'anticipation')).toMatchObject({
      status: 'warn',
      counts: {
        candidate_questions: 3,
        pack_entries: 2,
        probe_failures: 1,
        persisted_packs: 1,
      },
      errors: ['Anticipation probe failed for "retrieval pipeline": probe failed'],
      next_recommended_action: 'Read the precomputed pack via get_anticipation_pack at session start.',
      canonical_mutations: 0,
      llm_or_runner_used: false,
    });
    expect(setConfigCalls).toHaveLength(1);
    expect(setConfigCalls[0]?.[0]).toBe('anticipation_pack_latest');
    expect(JSON.parse(setConfigCalls[0]?.[1] ?? '')).toMatchObject({
      generated_at: '2026-07-06T00:00:00.000Z',
      candidate_question_count: 3,
    });
  });

  test('anticipation phase with the flag on builds an empty pack against a minimal engine', async () => {
    const result = await runDreamCycle(stubEngine(), {
      scope_id: 'workspace:default',
      now: '2026-07-06T00:00:00.000Z',
      dry_run: true,
      anticipation_enabled: true,
    });

    expect(result.phases.find((phase) => phase.family === 'anticipation')).toMatchObject({
      status: 'ok',
      counts: {
        candidate_questions: 0,
        pack_entries: 0,
        probe_failures: 0,
        persisted_packs: 0,
      },
      canonical_mutations: 0,
      llm_or_runner_used: false,
    });
  });
});

function stubEngine() {
  return {
    listMemoryCandidateEntries: async () => [],
  } as any;
}

function passingReplayCanary() {
  return {
    run: async () => ({
      status: 'passed' as const,
      reason_codes: ['focused_replay_canary_passed'],
    }),
  };
}
