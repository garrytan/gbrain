import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { createSqlMaintenanceRuntimeAdapter } from '../src/core/services/maintenance-runtime-db-adapter.ts';
import { createAutopilotService } from '../src/core/services/autopilot-service.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

describe('SQL maintenance runtime adapter', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    while (tempPaths.length > 0) {
      rmSync(tempPaths.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite autopilot submissions persist in memory_jobs and dedupe across service instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-maintenance-runtime-adapter-sqlite-'));
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const first = createAutopilotService({
      now: () => '2026-05-20T12:07:30.000Z',
      slotFor: () => '2026-05-20T12:00Z',
      getConfig: async () => ({ enabled: true, mode: 'cron' }),
      setConfig: async () => {},
      runtime: createSqlMaintenanceRuntimeAdapter(engine, { now: () => '2026-05-20T12:07:30.000Z' }),
    });
    const second = createAutopilotService({
      now: () => '2026-05-20T12:08:00.000Z',
      slotFor: () => '2026-05-20T12:00Z',
      getConfig: async () => ({ enabled: true, mode: 'cron' }),
      setConfig: async () => {},
      runtime: createSqlMaintenanceRuntimeAdapter(engine, { now: () => '2026-05-20T12:08:00.000Z' }),
    });

    expect(await first.runOnce({ requested_by: 'cli' })).toMatchObject({ status: 'submitted' });
    expect(await second.runOnce({ requested_by: 'cli' })).toMatchObject({ status: 'deduped' });

    const rows = (engine as any).database.query(`
      SELECT name, queue, status, idempotency_key, payload_json
      FROM memory_jobs
      ORDER BY created_at ASC
    `).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'autopilot_cycle',
      queue: 'maintenance',
      status: 'waiting',
      idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
    });
    expect(JSON.parse(String(rows[0].payload_json))).toMatchObject({
      trigger: 'run-once',
      slot: '2026-05-20T12:00Z',
    });

    await engine.disconnect();
  });

  test('pglite adapter coalesces distinct autopilot slots when max_waiting is one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-maintenance-runtime-adapter-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();
    const adapter = createSqlMaintenanceRuntimeAdapter(engine, { now: () => '2026-05-20T12:07:30.000Z' });

    await adapter.enqueueJob({
      name: 'autopilot_cycle',
      queue: 'maintenance',
      payload_json: { slot: '2026-05-20T12:00Z' },
      idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
      max_attempts: 1,
      max_waiting: 1,
    });
    const coalesced = await adapter.enqueueJob({
      name: 'autopilot_cycle',
      queue: 'maintenance',
      payload_json: { slot: '2026-05-20T12:15Z' },
      idempotency_key: 'autopilot-cycle:2026-05-20T12:15Z',
      max_attempts: 1,
      max_waiting: 1,
    });

    expect(coalesced).toMatchObject({
      status: 'coalesced',
      job: {
        name: 'autopilot_cycle',
        idempotency_key: 'autopilot-cycle:2026-05-20T12:15Z',
        payload_json: { slot: '2026-05-20T12:15Z' },
      },
    });
    const rows = await (engine as any).db.query(`SELECT * FROM memory_jobs`);
    expect(rows.rows).toHaveLength(1);

    await engine.disconnect();
  });

  test('pglite adapter claims a durable job with lock token and audit event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-maintenance-runtime-claim-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();
    const adapter = createSqlMaintenanceRuntimeAdapter(engine, { now: () => '2026-05-20T12:07:30.000Z' });
    await adapter.enqueueJob({
      name: 'projection_refresh',
      queue: 'maintenance',
      payload_json: { target: 'systems/mbrain' },
      idempotency_key: 'projection-refresh:systems/mbrain:hash-1',
      max_attempts: 2,
      timeout_ms: 1_000,
    });

    const claimed = await adapter.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:pglite',
      lease_ms: 30_000,
    });

    expect(claimed).toMatchObject({
      name: 'projection_refresh',
      status: 'active',
      attempts_started: 1,
      lock_owner: 'worker:pglite',
      lock_expires_at: expect.anything(),
      timeout_at: expect.anything(),
    });
    expect(String(claimed?.lock_token)).toMatch(/^lock-token:/);
    const events = await (engine as any).db.query(`
      SELECT event_type, worker_id
      FROM memory_job_events
      WHERE job_id = $1
      ORDER BY created_at ASC
    `, [claimed?.id]);
    expect(events.rows).toContainEqual({
      event_type: 'job_claimed',
      worker_id: 'worker:pglite',
    });

    await engine.disconnect();
  });

  test('pglite adapter claims a specific named job without activating unrelated entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-maintenance-runtime-claim-specific-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();
    const adapter = createSqlMaintenanceRuntimeAdapter(engine, { now: () => '2026-05-20T12:07:30.000Z' });
    const unrelated = await adapter.enqueueJob({
      name: 'projection_refresh',
      queue: 'maintenance',
      priority: 10,
      max_attempts: 1,
    });
    const target = await adapter.enqueueJob({
      name: 'embed_backfill',
      queue: 'maintenance',
      priority: 0,
      max_attempts: 1,
    });

    expect(await adapter.claimJob({
      job_id: String(unrelated.job.id),
      name: 'embed_backfill',
      queue: 'maintenance',
      worker_id: 'worker:embed',
      lease_ms: 30_000,
    })).toBeNull();

    const claimed = await adapter.claimJob({
      job_id: String(target.job.id),
      name: 'embed_backfill',
      queue: 'maintenance',
      worker_id: 'worker:embed',
      lease_ms: 30_000,
    });

    expect(claimed).toMatchObject({
      id: target.job.id,
      name: 'embed_backfill',
      status: 'active',
      lock_owner: 'worker:embed',
    });
    expect(await adapter.getJob(String(unrelated.job.id))).toMatchObject({
      status: 'waiting',
      attempts_started: 0,
    });

    await engine.disconnect();
  });

  test('pglite adapter completes fails retries and sweeps jobs durably', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-maintenance-runtime-lifecycle-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();
    let currentNow = '2026-05-20T12:00:00.000Z';
    const adapter = createSqlMaintenanceRuntimeAdapter(engine, { now: () => currentNow });

    await adapter.enqueueJob({
      name: 'complete_me',
      queue: 'maintenance',
      payload_json: { target: 'done' },
      max_attempts: 1,
    });
    const completedClaim = await adapter.claimNextJob({ queue: 'maintenance', worker_id: 'worker:1', lease_ms: 10_000 });
    const completed = await adapter.completeJob({
      job_id: String(completedClaim?.id),
      lock_token: String(completedClaim?.lock_token),
      result_json: { ok: true },
    });
    expect(completed).toMatchObject({
      status: 'completed',
      attempts_started: 1,
      attempts_finished: 1,
      result_json: { ok: true },
      lock_token: null,
    });

    await adapter.enqueueJob({
      name: 'retry_me',
      queue: 'maintenance',
      payload_json: { target: 'retry' },
      max_attempts: 2,
      backoff_type: 'fixed',
      backoff_delay_ms: 5_000,
    });
    const failedClaim = await adapter.claimNextJob({ queue: 'maintenance', worker_id: 'worker:1', lease_ms: 10_000 });
    const delayed = await adapter.failJob({
      job_id: String(failedClaim?.id),
      lock_token: String(failedClaim?.lock_token),
      failure_class: 'database',
      message: 'temporary database outage',
    });
    expect(delayed).toMatchObject({
      status: 'delayed',
      attempts_finished: 1,
      failure_class: 'database',
      last_error: 'temporary database outage',
      next_run_at: '2026-05-20T12:00:05.000Z',
    });

    currentNow = '2026-05-20T12:00:05.000Z';
    const retryClaim = await adapter.claimNextJob({ queue: 'maintenance', worker_id: 'worker:2', lease_ms: 10_000 });
    const dead = await adapter.failJob({
      job_id: String(retryClaim?.id),
      lock_token: String(retryClaim?.lock_token),
      failure_class: 'policy_denied',
      message: 'policy rejected',
    });
    expect(dead).toMatchObject({
      status: 'dead',
      attempts_started: 2,
      attempts_finished: 2,
      failure_class: 'policy_denied',
      finished_at: '2026-05-20T12:00:05.000Z',
    });

    currentNow = '2026-05-20T12:01:00.000Z';
    await adapter.enqueueJob({
      name: 'timeout_me',
      queue: 'maintenance',
      max_attempts: 1,
      timeout_ms: 1_000,
    });
    await adapter.claimNextJob({ queue: 'maintenance', worker_id: 'worker:3', lease_ms: 10_000 });
    currentNow = '2026-05-20T12:01:01.000Z';
    const swept = await adapter.sweepTimedOutJobs();
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({
      status: 'dead',
      failure_class: 'timeout',
      last_error: 'maintenance job timed out',
    });

    const events = await adapter.listJobEvents(String(dead.id));
    expect(events.map((event) => event.event_type)).toContain('job_dead');
    expect(events.find((event) => event.event_type === 'job_dead')).toMatchObject({
      failure_class: 'policy_denied',
    });

    await engine.disconnect();
  });

  test('sqlite and pglite adapters renew active leases and durable progress', async () => {
    for (const kind of ['sqlite', 'pglite'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `mbrain-maintenance-runtime-renew-${kind}-`));
      tempPaths.push(dir);
      const engine = kind === 'sqlite' ? new SQLiteEngine() : new PGLiteEngine();
      const databasePath = kind === 'sqlite' ? join(dir, 'brain.db') : dir;
      await engine.connect({ engine: kind, database_path: databasePath });
      await engine.initSchema();
      let currentNow = '2026-05-20T12:00:00.000Z';
      const adapter = createSqlMaintenanceRuntimeAdapter(engine, { now: () => currentNow });

      await adapter.enqueueJob({
        name: 'embed_backfill',
        queue: 'maintenance',
        payload_json: { mode: 'stale' },
        progress_json: { page_offset: 0, chunks_embedded: 0 },
        idempotency_key: 'embed-backfill:stale:default',
        max_attempts: 2,
      });
      const claimed = await adapter.claimNextJob({
        queue: 'maintenance',
        worker_id: 'worker:embed',
        lease_ms: 10_000,
      });

      currentNow = '2026-05-20T12:00:02.000Z';
      const renewedWithoutProgress = await adapter.renewJobLease({
        job_id: String(claimed?.id),
        lock_token: String(claimed?.lock_token),
        lease_ms: 20_000,
      });
      expect(renewedWithoutProgress).toMatchObject({
        lock_expires_at: '2026-05-20T12:00:22.000Z',
        progress_json: { page_offset: 0, chunks_embedded: 0 },
      });

      currentNow = '2026-05-20T12:00:05.000Z';
      const renewed = await adapter.renewJobLease({
        job_id: String(claimed?.id),
        lock_token: String(claimed?.lock_token),
        lease_ms: 30_000,
        progress_json: { page_offset: 500, chunks_embedded: 42 },
      });

      expect(renewed).toMatchObject({
        status: 'active',
        lock_owner: 'worker:embed',
        lock_expires_at: '2026-05-20T12:00:35.000Z',
        updated_at: '2026-05-20T12:00:05.000Z',
        progress_json: { page_offset: 500, chunks_embedded: 42 },
      });
      expect(await adapter.listJobEvents(String(claimed?.id))).toContainEqual(
        expect.objectContaining({
          event_type: 'job_lease_renewed',
          metadata_json: {
            lease_ms: 30_000,
            progress_updated: true,
          },
        }),
      );

      currentNow = '2026-05-20T12:00:10.001Z';
      expect(await adapter.claimNextJob({
        queue: 'maintenance',
        worker_id: 'worker:other',
        lease_ms: 10_000,
      })).toBeNull();

      await expect(adapter.renewJobLease({
        job_id: String(claimed?.id),
        lock_token: 'lock-token:wrong',
        lease_ms: 30_000,
        progress_json: { page_offset: 999 },
      })).rejects.toThrow(/lock token mismatch/i);
      expect(await adapter.getJob(String(claimed?.id))).toMatchObject({
        progress_json: { page_offset: 500, chunks_embedded: 42 },
      });

      currentNow = '2026-05-20T12:00:35.001Z';
      const reclaimed = await adapter.claimNextJob({
        queue: 'maintenance',
        worker_id: 'worker:other',
        lease_ms: 10_000,
      });
      expect(reclaimed).toMatchObject({
        id: claimed?.id,
        status: 'active',
        attempts_started: 2,
        lock_owner: 'worker:other',
      });

      await engine.disconnect();
    }
  });

  test('sql adapter pauses claims under foreground pressure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-maintenance-runtime-pressure-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();
    const adapter = createSqlMaintenanceRuntimeAdapter(engine, {
      now: () => '2026-05-20T12:00:00.000Z',
      foregroundPressure: () => ({ active: true, reason: 'active_mcp_write' }),
    });

    await adapter.enqueueJob({
      name: 'embed_backfill',
      queue: 'maintenance',
      max_attempts: 1,
    });

    expect(await adapter.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:paused',
      lease_ms: 10_000,
    })).toBeNull();
    expect(await adapter.listRuntimeEvents()).toContainEqual(
      expect.objectContaining({
        event_type: 'claim_paused_for_foreground_pressure',
        metadata_json: { reason: 'active_mcp_write' },
      }),
    );
    expect(await adapter.listJobs({ name: 'embed_backfill' })).toEqual([
      expect.objectContaining({ status: 'waiting', attempts_started: 0 }),
    ]);

    await engine.disconnect();
  });

  test('pglite adapter persists cycle locks heartbeats and runtime status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-maintenance-runtime-status-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();
    const adapter = createSqlMaintenanceRuntimeAdapter(engine, { now: () => '2026-05-20T12:00:00.000Z' });

    const acquired = await adapter.acquireCycleLock({
      cycle_name: 'autopilot_cycle',
      holder_pid: 100,
      holder_host: 'host-a',
      holder_kind: 'daemon',
      ttl_ms: 60_000,
    });
    expect(acquired).toMatchObject({
      status: 'acquired',
      lock: {
        cycle_name: 'autopilot_cycle',
        holder_pid: 100,
        holder_host: 'host-a',
        holder_kind: 'daemon',
      },
    });
    await expect(adapter.acquireCycleLock({
      cycle_name: 'autopilot_cycle',
      holder_pid: 100,
      holder_host: 'host-a',
      holder_kind: 'manual',
      ttl_ms: 60_000,
    })).resolves.toMatchObject({
      status: 'busy',
      current_holder: { holder_kind: 'daemon' },
    });

    await adapter.recordWorkerHeartbeat({
      worker_id: 'worker:status',
      worker_host: 'host-a',
      worker_pid: 101,
      queues: ['maintenance'],
      metadata_json: { version: 'test' },
    });
    await adapter.enqueueJob({
      name: 'queued_status',
      queue: 'maintenance',
      max_attempts: 1,
    });

    const status = await adapter.getStatus();
    expect(status.queue_depth).toMatchObject({ maintenance: 1 });
    expect(status.active_cycle_locks).toHaveLength(1);
    expect(status.worker_heartbeats).toHaveLength(1);
    expect(await adapter.releaseCycleLock({
      cycle_name: 'autopilot_cycle',
      holder_pid: 100,
      holder_host: 'host-a',
      holder_kind: 'manual',
    })).toEqual({ status: 'not_holder' });
    expect(await adapter.releaseCycleLock({
      cycle_name: 'autopilot_cycle',
      holder_pid: 100,
      holder_host: 'host-a',
      holder_kind: 'daemon',
    })).toEqual({ status: 'released' });
    expect(await adapter.getActiveCycleLock()).toBeNull();

    await engine.disconnect();
  });
});
