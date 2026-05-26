import { describe, expect, test } from 'bun:test';

const START = Date.parse('2026-05-20T12:07:30.000Z');

describe('autopilot service', () => {
  test('install profile renders launchd systemd cron and manual content without secrets', async () => {
    const harness = await createHarness();
    const profiles = ['launchd', 'systemd', 'cron', 'manual'] as const;

    for (const profile of profiles) {
      const rendered = harness.service.renderInstallProfile({
        profile,
        command: '/usr/local/bin/mbrain',
        config_path: '/Users/alice/.mbrain/config.json',
        schedule: '*/10 * * * *',
        database_url: 'postgresql://mbrain:db-password-123@db.example.com:5432/mbrain',
        env: {
          OPENAI_API_KEY: 'sk-live-secret',
          ANTHROPIC_API_KEY: 'anthropic-secret',
        },
        log_dir: '/Users/alice/.mbrain/logs',
      });

      expect(rendered.profile).toBe(profile);
      expect(rendered.content).toContain('/usr/local/bin/mbrain');
      expect(rendered.content).toContain('/Users/alice/.mbrain/config.json');
      expect(rendered.content).not.toContain('db-password-123');
      expect(rendered.content).not.toContain('sk-live-secret');
      expect(rendered.content).not.toContain('anthropic-secret');
      expect(rendered.content).not.toContain('postgresql://mbrain:db-password-123@');
    }

    expect(harness.service.renderInstallProfile({ profile: 'launchd' }).content).toContain('com.mbrain.autopilot');
    expect(harness.service.renderInstallProfile({ profile: 'systemd' }).content).toContain('[Unit]');
    expect(harness.service.renderInstallProfile({ profile: 'cron' }).content).toContain('mbrain autopilot run-once');
    expect(harness.service.renderInstallProfile({ profile: 'cron', schedule: '*/10 * * * *' }).content)
      .toContain('*/10 * * * *');
    expect(harness.service.renderInstallProfile({ profile: 'manual' }).content).toContain('mbrain autopilot run-once');
  });

  test('enable records config and submits or starts according to configured mode', async () => {
    const harness = await createHarness();

    await harness.service.enable({
      mode: 'cron',
      schedule: '*/15 * * * *',
      allow_llm: false,
      allow_local_runner: false,
      source_consent_defaults: 'deny_raw_until_granted',
      start_now: true,
    });

    expect(harness.configWrites).toContainEqual({
      key: 'autopilot',
      value: expect.objectContaining({
        enabled: true,
        mode: 'cron',
        schedule: '*/15 * * * *',
        allow_llm: false,
        allow_local_runner: false,
        source_consent_defaults: 'deny_raw_until_granted',
      }),
    });
    expect(harness.schedulerActions).toEqual([{ action: 'install', mode: 'cron' }]);
    expect(harness.enqueuedJobs).toContainEqual(expect.objectContaining({
      name: 'autopilot_cycle',
      queue: 'maintenance',
      idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
      max_waiting: 1,
    }));

    const manualHarness = await createHarness();
    await manualHarness.service.enable({ mode: 'manual', start_now: true });
    expect(manualHarness.schedulerActions).toEqual([{ action: 'start_foreground', mode: 'manual' }]);
  });

  test('repeated daemon tick dedupes by idempotency key using the maintenance runtime primitive', async () => {
    const harness = await createHarness();

    const first = await harness.service.tick({ trigger: 'daemon' });
    const second = await harness.service.tick({ trigger: 'daemon' });

    expect(first).toMatchObject({ status: 'submitted' });
    expect(second).toMatchObject({ status: 'deduped' });
    expect(harness.enqueuedJobs).toEqual([
      expect.objectContaining({
        name: 'autopilot_cycle',
        idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
        max_waiting: 1,
      }),
      expect.objectContaining({
        name: 'autopilot_cycle',
        idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
        max_waiting: 1,
      }),
    ]);
    expect(harness.maintenanceDedupCalls).toEqual(['autopilot-cycle:2026-05-20T12:00Z']);
  });

  test('run-once uses the same cycle primitive as daemon tick', async () => {
    const harness = await createHarness();

    await harness.service.tick({ trigger: 'daemon' });
    await harness.service.runOnce({ requested_by: 'cli' });

    expect(harness.enqueuedJobs.map(job => ({
      name: job.name,
      idempotency_key: job.idempotency_key,
      max_waiting: job.max_waiting,
    }))).toEqual([
      {
        name: 'autopilot_cycle',
        idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
        max_waiting: 1,
      },
      {
        name: 'autopilot_cycle',
        idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
        max_waiting: 1,
      },
    ]);
  });

  test('run-once executes dream lifecycle work when a dream runner is configured', async () => {
    const dreamInputs: Array<Record<string, unknown>> = [];
    const harness = await createHarness({
      dreamRunner: async (input) => {
        dreamInputs.push(input as Record<string, unknown>);
        return { status: 'ok', phases: [{ family: 'forgetting_review', counts: { lifecycle_transitions: 1 } }] };
      },
    });

    const result = await harness.service.runOnce({ requested_by: 'cli' });
    const deduped = await harness.service.tick({ trigger: 'daemon' });

    expect(result).toMatchObject({
      status: 'completed',
      dream_result: {
        status: 'ok',
        phases: [{ family: 'forgetting_review', counts: { lifecycle_transitions: 1 } }],
      },
    });
    expect(deduped).toMatchObject({ status: 'deduped' });
    expect(dreamInputs).toEqual([{
      scope_id: 'workspace:default',
      now: '2026-05-20T12:07:30.000Z',
      dry_run: false,
      write_candidates: true,
      allow_llm: false,
      allow_local_runner: false,
      trigger: 'autopilot',
    }]);
    expect(harness.completedJobs).toEqual([
      expect.objectContaining({
        job_id: 'job:autopilot-cycle',
        result_json: expect.objectContaining({
          dream_result: expect.objectContaining({ status: 'ok' }),
        }),
      }),
    ]);
  });

  test('inline dream runner failures mark the durable job failed with a valid failure class', async () => {
    const harness = await createHarness({
      dreamRunner: async () => {
        throw new Error('dream runner exploded');
      },
    });

    await expect(harness.service.runOnce({ requested_by: 'cli' })).rejects.toThrow('dream runner exploded');

    expect(harness.failedJobs).toEqual([
      expect.objectContaining({
        job_id: 'job:autopilot-cycle',
        failure_class: 'internal',
        message: 'dream runner exploded',
        retryable: false,
      }),
    ]);
  });

  test('inline dream runner resolved failures mark the durable job failed instead of completed', async () => {
    const harness = await createHarness({
      dreamRunner: async () => ({
        status: 'failed',
        summary_lines: ['forgetting review failed'],
        phases: [
          {
            family: 'forgetting_review',
            status: 'failed',
            errors: ['lifecycle store unavailable'],
          },
        ],
      }),
    });

    const result = await harness.service.runOnce({ requested_by: 'cli' });

    expect(result).toMatchObject({
      status: 'failed',
      dream_result: {
        status: 'failed',
        summary_lines: ['forgetting review failed'],
      },
    });
    expect(harness.completedJobs).toEqual([]);
    expect(harness.failedJobs).toEqual([
      expect.objectContaining({
        job_id: 'job:autopilot-cycle',
        failure_class: 'internal',
        message: 'forgetting review failed',
        retryable: false,
      }),
    ]);
  });

  test('daemon tick executes dream lifecycle work when the cycle is not deduped', async () => {
    const dreamInputs: Array<Record<string, unknown>> = [];
    const harness = await createHarness({
      dreamRunner: async (input) => {
        dreamInputs.push(input as Record<string, unknown>);
        return { status: 'ok' };
      },
    });

    const result = await harness.service.tick({ trigger: 'daemon' });

    expect(result).toMatchObject({ status: 'completed', dream_result: { status: 'ok' } });
    expect(dreamInputs).toHaveLength(1);
    expect(dreamInputs[0]).toMatchObject({
      dry_run: false,
      write_candidates: true,
      trigger: 'autopilot',
    });
    expect(harness.completedJobs).toHaveLength(1);
  });

  test('no-worker warning surfaces when queued jobs pile up without recent heartbeat', async () => {
    const harness = await createHarness({
      jobs: [
        { id: 'job:1', name: 'autopilot_cycle', status: 'waiting' },
        { id: 'job:2', name: 'autopilot_cycle', status: 'waiting' },
        { id: 'job:3', name: 'autopilot_cycle', status: 'waiting' },
      ],
      workerHeartbeats: [
        { worker_id: 'worker:old', heartbeat_at: '2026-05-20T11:00:00.000Z' },
      ],
    });

    const status = await harness.service.status({ now: '2026-05-20T12:07:30.000Z' });

    expect(status.warnings).toContainEqual(expect.objectContaining({
      code: 'no_recent_worker_heartbeat',
      severity: 'warning',
      queue_depth: 3,
    }));
  });

  test('status reports active cycle lock and last cycle result', async () => {
    const harness = await createHarness({
      activeCycleLock: {
        cycle_name: 'autopilot_cycle',
        holder_kind: 'daemon',
        holder_host: 'host-a',
        holder_pid: 4242,
        heartbeat_at: '2026-05-20T12:07:00.000Z',
      },
      lastCycleResult: {
        idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
        status: 'completed',
        finished_at: '2026-05-20T12:06:00.000Z',
        summary: 'reviewed 4 stale signals',
      },
    });

    await expect(harness.service.status()).resolves.toMatchObject({
      active_cycle_lock: {
        cycle_name: 'autopilot_cycle',
        holder_kind: 'daemon',
        holder_host: 'host-a',
        holder_pid: 4242,
      },
      last_cycle_result: {
        idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
        status: 'completed',
        summary: 'reviewed 4 stale signals',
      },
    });
  });

  test('disable prevents future submissions', async () => {
    const harness = await createHarness({
      autopilotConfig: { enabled: true, mode: 'cron' },
    });

    await harness.service.disable();
    const result = await harness.service.tick({ trigger: 'daemon' });
    const runOnce = await harness.service.runOnce({ requested_by: 'cli' });

    expect(harness.configWrites).toContainEqual({
      key: 'autopilot',
      value: expect.objectContaining({ enabled: false }),
    });
    expect(harness.schedulerActions).toContainEqual({ action: 'stop', mode: 'cron' });
    expect(result).toMatchObject({ status: 'disabled' });
    expect(runOnce).toMatchObject({ status: 'disabled' });
    expect(harness.enqueuedJobs).toEqual([]);
  });

  test('default install path returns rendered profile instead of claiming scheduler mutation', async () => {
    const { createAutopilotService } = await import('../src/core/services/autopilot-service.ts');
    const service = createAutopilotService({
      getConfig: async () => ({ enabled: true, mode: 'cron', schedule: '*/10 * * * *' }),
      setConfig: async () => {},
    });

    await expect(service.install({ profile: 'cron' })).resolves.toMatchObject({
      installed: false,
      profile: 'cron',
      reason: 'scheduler_not_configured',
      profile_content: expect.stringContaining('*/10 * * * *'),
    });
  });

  test('default in-process claimJob does not claim a different queued job when the requested id is not next', async () => {
    const { createInProcessRuntimeAdapter } = await import('../src/core/services/autopilot-service.ts');
    const { createMaintenanceRuntimeService } = await import('../src/core/services/maintenance-runtime-service.ts');
    let id = 0;
    const runtime = createMaintenanceRuntimeService({
      now: () => '2026-05-20T12:07:30.000Z',
      nextId: (prefix: string) => `${prefix}:${++id}`,
    });
    const adapter = createInProcessRuntimeAdapter(runtime, () => '2026-05-20T12:07:30.000Z');
    const older = await runtime.enqueueJob({ name: 'older_maintenance', queue: 'maintenance' });
    const target = await runtime.enqueueJob({ name: 'autopilot_cycle', queue: 'maintenance' });

    const claimed = await adapter.claimJob?.({
      job_id: target.job.id,
      queue: 'maintenance',
      worker_id: 'autopilot:inline',
      lease_ms: 60_000,
    });

    expect(claimed).toBeNull();
    await expect(runtime.getJob(older.job.id)).resolves.toMatchObject({ status: 'waiting' });
    await expect(runtime.getJob(target.job.id)).resolves.toMatchObject({ status: 'waiting' });
  });
});

interface AutopilotHarnessOverrides {
  autopilotConfig?: Record<string, unknown>;
  jobs?: Array<Record<string, unknown>>;
  workerHeartbeats?: Array<Record<string, unknown>>;
  activeCycleLock?: Record<string, unknown> | null;
  lastCycleResult?: Record<string, unknown> | null;
  dreamRunner?: (input: any) => Promise<Record<string, unknown>>;
}

async function createHarness(overrides: AutopilotHarnessOverrides = {}) {
  const { createAutopilotService } = await import('../src/core/services/autopilot-service.ts');
  let nowMs = START;
  const configWrites: Array<{ key: string; value: unknown }> = [];
  const schedulerActions: Array<Record<string, unknown>> = [];
  const enqueuedJobs: Array<Record<string, unknown>> = [];
  const completedJobs: Array<Record<string, unknown>> = [];
  const failedJobs: Array<Record<string, unknown>> = [];
  const maintenanceDedupCalls: string[] = [];
  const seenIdempotencyKeys = new Set<string>();

  const service = createAutopilotService({
    now: () => new Date(nowMs).toISOString(),
    slotFor: () => '2026-05-20T12:00Z',
    getConfig: async () => ({
      enabled: true,
      mode: 'cron',
      schedule: '*/15 * * * *',
      ...(overrides.autopilotConfig as Record<string, unknown> | undefined),
    }),
    setConfig: async (key: string, value: unknown) => {
      configWrites.push({ key, value });
    },
    scheduler: {
      install: async (input: Record<string, unknown>) => {
        schedulerActions.push({ action: 'install', mode: input.mode });
      },
      startForeground: async (input: Record<string, unknown>) => {
        schedulerActions.push({ action: 'start_foreground', mode: input.mode });
      },
      stop: async (input: Record<string, unknown>) => {
        schedulerActions.push({ action: 'stop', mode: input.mode });
      },
    },
    runtime: {
      enqueueJob: async (job: Record<string, unknown>) => {
        enqueuedJobs.push(job);
        const key = String(job.idempotency_key);
        if (seenIdempotencyKeys.has(key)) {
          maintenanceDedupCalls.push(key);
          return { status: 'deduped', job: { id: 'job:autopilot-cycle', ...job } };
        }
        seenIdempotencyKeys.add(key);
        return { status: 'submitted', job: { id: 'job:autopilot-cycle', ...job } };
      },
      claimJob: async (input: Record<string, unknown>) => ({
        id: input.job_id,
        status: 'active',
        lock_token: 'lock-token:autopilot-inline',
      }),
      completeJob: async (input: Record<string, unknown>) => {
        completedJobs.push(input);
        return {
          id: input.job_id,
          status: 'completed',
          result_json: input.result_json,
        };
      },
      failJob: async (input: Record<string, unknown>) => {
        failedJobs.push(input);
        return {
          id: input.job_id,
          status: 'failed',
          failure_class: input.failure_class,
          last_error: input.message,
        };
      },
      listJobs: async () => overrides.jobs ?? [],
      listWorkerHeartbeats: async () => overrides.workerHeartbeats ?? [],
      getActiveCycleLock: async () => overrides.activeCycleLock ?? null,
      getLastCycleResult: async () => overrides.lastCycleResult ?? null,
    },
    ...(overrides.dreamRunner ? { dreamRunner: overrides.dreamRunner } : {}),
  });

  return {
    service,
    configWrites,
    schedulerActions,
    enqueuedJobs,
    completedJobs,
    failedJobs,
    maintenanceDedupCalls,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}
