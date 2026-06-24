import { describe, expect, test } from 'bun:test';
import {
  createMaintenanceRuntimeService,
  type MaintenanceRuntimeServiceOptions,
} from '../src/core/services/maintenance-runtime-service.ts';

const START = Date.parse('2026-05-20T12:00:00.000Z');

describe('maintenance runtime service', () => {
  test('worker claims job with lock token', async () => {
    const harness = createHarness();
    const submitted = await harness.service.enqueueJob({
      name: 'projection-refresh',
      queue: 'maintenance',
      payload_json: { target: 'systems/mbrain' },
      idempotency_key: 'projection:systems/mbrain:hash-1',
      max_attempts: 3,
    });

    const claimed = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:a',
      lease_ms: 30_000,
    });

    expect(claimed).toMatchObject({
      id: submitted.job.id,
      name: 'projection-refresh',
      queue: 'maintenance',
      status: 'active',
      attempts_started: 1,
      lock_owner: 'worker:a',
      lock_expires_at: '2026-05-20T12:00:30.000Z',
    });
    expect(claimed?.lock_token).toMatch(/^lock-token:/);

    const job = await harness.service.getJob(submitted.job.id);
    expect(job).toMatchObject({
      status: 'active',
      lock_token: claimed?.lock_token,
      started_at: '2026-05-20T12:00:00.000Z',
    });
  });

  test('worker claims a specific job without activating unrelated queue entries', async () => {
    const harness = createHarness();
    const unrelated = await harness.service.enqueueJob({
      name: 'projection-refresh',
      queue: 'maintenance',
      priority: 10,
    });
    const target = await harness.service.enqueueJob({
      name: 'embed_backfill',
      queue: 'maintenance',
      priority: 0,
    });

    const claimed = await harness.service.claimJob({
      job_id: target.job.id,
      queue: 'maintenance',
      worker_id: 'worker:embed',
      lease_ms: 30_000,
    });

    expect(claimed).toMatchObject({
      id: target.job.id,
      status: 'active',
      lock_owner: 'worker:embed',
    });
    expect(await harness.service.getJob(unrelated.job.id)).toMatchObject({
      status: 'waiting',
      attempts_started: 0,
    });
  });

  test('stale lock can be reclaimed', async () => {
    const harness = createHarness();
    const submitted = await harness.service.enqueueJob({
      name: 'assertion-resolution',
      queue: 'maintenance',
      payload_json: { batch: 'claims:1' },
      idempotency_key: 'assertion-resolution:slot-1',
      max_attempts: 3,
    });
    const firstClaim = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:stale',
      lease_ms: 10_000,
    });

    harness.advance(10_001);

    const reclaimed = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:fresh',
      lease_ms: 20_000,
    });

    expect(reclaimed).toMatchObject({
      id: submitted.job.id,
      status: 'active',
      attempts_started: 2,
      lock_owner: 'worker:fresh',
      lock_expires_at: '2026-05-20T12:00:30.001Z',
    });
    expect(reclaimed?.lock_token).not.toBe(firstClaim?.lock_token);
    expect(await harness.service.listJobEvents(submitted.job.id)).toContainEqual(
      expect.objectContaining({
        event_type: 'stale_lock_reclaimed',
        worker_id: 'worker:fresh',
      }),
    );
  });

  test('renewing an active lease extends reclaim time and replaces progress', async () => {
    const harness = createHarness();
    const submitted = await harness.service.enqueueJob({
      name: 'embed_backfill',
      queue: 'maintenance',
      payload_json: { mode: 'stale' },
      progress_json: { page_offset: 0, chunks_embedded: 0 },
      idempotency_key: 'embed-backfill:stale:default',
      max_attempts: 2,
    });
    const claimed = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:embed',
      lease_ms: 10_000,
    });

    harness.advance(2_000);
    const renewedWithoutProgress = await harness.service.renewJobLease({
      job_id: submitted.job.id,
      lock_token: claimed?.lock_token ?? '',
      lease_ms: 20_000,
    });
    expect(renewedWithoutProgress).toMatchObject({
      lock_expires_at: '2026-05-20T12:00:22.000Z',
      progress_json: { page_offset: 0, chunks_embedded: 0 },
    });

    harness.advance(3_000);
    const renewed = await harness.service.renewJobLease({
      job_id: submitted.job.id,
      lock_token: claimed?.lock_token ?? '',
      lease_ms: 30_000,
      progress_json: { page_offset: 500, chunks_embedded: 42 },
    });

    expect(renewed).toMatchObject({
      id: submitted.job.id,
      status: 'active',
      lock_owner: 'worker:embed',
      lock_expires_at: '2026-05-20T12:00:35.000Z',
      updated_at: '2026-05-20T12:00:05.000Z',
      progress_json: { page_offset: 500, chunks_embedded: 42 },
    });
    expect(await harness.service.listJobEvents(submitted.job.id)).toContainEqual(
      expect.objectContaining({
        event_type: 'job_lease_renewed',
        metadata_json: {
          lease_ms: 30_000,
          progress_updated: true,
        },
      }),
    );

    harness.advance(5_001);
    expect(await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:other',
      lease_ms: 10_000,
    })).toBeNull();

    harness.advance(25_000);
    const reclaimed = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:other',
      lease_ms: 10_000,
    });
    expect(reclaimed).toMatchObject({
      id: submitted.job.id,
      status: 'active',
      attempts_started: 2,
      lock_owner: 'worker:other',
    });
  });

  test('renewing a lease rejects wrong token or non-active jobs without changing progress', async () => {
    const harness = createHarness();
    const submitted = await harness.service.enqueueJob({
      name: 'embed_backfill',
      queue: 'maintenance',
      progress_json: { page_offset: 0 },
      max_attempts: 1,
    });
    const claimed = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:embed',
      lease_ms: 10_000,
    });

    await expect(harness.service.renewJobLease({
      job_id: submitted.job.id,
      lock_token: 'lock-token:wrong',
      lease_ms: 30_000,
      progress_json: { page_offset: 500 },
    })).rejects.toThrow(/lock token mismatch/i);
    expect(await harness.service.getJob(submitted.job.id)).toMatchObject({
      progress_json: { page_offset: 0 },
    });

    await harness.service.completeJob({
      job_id: submitted.job.id,
      lock_token: claimed?.lock_token ?? '',
      result_json: { embedded: 0 },
    });
    await expect(harness.service.renewJobLease({
      job_id: submitted.job.id,
      lock_token: claimed?.lock_token ?? '',
      lease_ms: 30_000,
    })).rejects.toThrow(/not active/i);
    expect((await harness.service.listJobEvents(submitted.job.id))
      .filter((event) => event.event_type === 'job_lease_renewed')).toHaveLength(0);
  });

  test('idempotency key dedupes repeated submissions', async () => {
    const harness = createHarness();

    const first = await harness.service.enqueueJob({
      name: 'dream-phase',
      queue: 'maintenance',
      payload_json: { phase: 'linking', slot: '2026-05-20T12:00Z' },
      idempotency_key: 'dream:linking:2026-05-20T12:00Z',
      max_attempts: 2,
    });
    const duplicate = await harness.service.enqueueJob({
      name: 'dream-phase',
      queue: 'maintenance',
      payload_json: { phase: 'linking', slot: '2026-05-20T12:00Z', duplicate: true },
      idempotency_key: 'dream:linking:2026-05-20T12:00Z',
      max_attempts: 2,
    });

    expect(duplicate).toMatchObject({
      status: 'deduped',
      job: { id: first.job.id, idempotency_key: 'dream:linking:2026-05-20T12:00Z' },
    });
    expect(await harness.service.listJobs({ name: 'dream-phase' })).toHaveLength(1);
  });

  test('max waiting coalesces wedged recurring submissions instead of piling up', async () => {
    const harness = createHarness({
      max_waiting_by_name: {
        'autopilot-cycle': 1,
      },
    });

    const first = await harness.service.enqueueJob({
      name: 'autopilot-cycle',
      queue: 'maintenance',
      payload_json: { slot: '2026-05-20T12:00Z', requested_by: 'timer-1' },
      idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
      max_attempts: 1,
    });
    const coalesced = await harness.service.enqueueJob({
      name: 'autopilot-cycle',
      queue: 'maintenance',
      payload_json: { slot: '2026-05-20T12:05Z', requested_by: 'timer-2' },
      idempotency_key: 'autopilot-cycle:2026-05-20T12:05Z',
      max_attempts: 1,
    });

    expect(coalesced).toMatchObject({
      status: 'coalesced',
      job: {
        id: first.job.id,
        payload_json: {
          slot: '2026-05-20T12:05Z',
          requested_by: 'timer-2',
        },
      },
    });
    expect(await harness.service.listJobs({ name: 'autopilot-cycle', status: 'waiting' }))
      .toHaveLength(1);
    expect(await harness.service.listJobEvents(first.job.id)).toContainEqual(
      expect.objectContaining({
        event_type: 'submission_coalesced',
        metadata_json: {
          coalesced_idempotency_key: 'autopilot-cycle:2026-05-20T12:05Z',
        },
      }),
    );
  });

  test('max waiting treats delayed retries as queued recurring work', async () => {
    const harness = createHarness({
      max_waiting_by_name: {
        'autopilot-cycle': 1,
      },
    });

    const first = await harness.service.enqueueJob({
      name: 'autopilot-cycle',
      queue: 'maintenance',
      payload_json: { slot: '2026-05-20T12:00Z' },
      idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
      max_attempts: 2,
      backoff_type: 'fixed',
      backoff_delay_ms: 60_000,
    });
    const claimed = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:a',
      lease_ms: 30_000,
    });
    await harness.service.failJob({
      job_id: first.job.id,
      lock_token: claimed?.lock_token ?? '',
      failure_class: 'database',
      message: 'temporary database pressure',
      retryable: true,
    });

    const coalesced = await harness.service.enqueueJob({
      name: 'autopilot-cycle',
      queue: 'maintenance',
      payload_json: { slot: '2026-05-20T12:15Z' },
      idempotency_key: 'autopilot-cycle:2026-05-20T12:15Z',
      max_attempts: 1,
    });

    expect(coalesced).toMatchObject({
      status: 'coalesced',
      job: {
        id: first.job.id,
        status: 'delayed',
        payload_json: { slot: '2026-05-20T12:15Z' },
      },
    });
    expect(await harness.service.listJobs({ name: 'autopilot-cycle' })).toHaveLength(1);
  });

  test('retry backoff max attempts and failure class are recorded deterministically', async () => {
    const harness = createHarness();
    const submitted = await harness.service.enqueueJob({
      name: 'projection-refresh',
      queue: 'maintenance',
      payload_json: { target: 'systems/mbrain' },
      idempotency_key: 'projection:systems/mbrain:hash-2',
      max_attempts: 2,
      backoff_type: 'fixed',
      backoff_delay_ms: 5_000,
    });
    const firstClaim = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:a',
      lease_ms: 30_000,
    });

    const delayed = await harness.service.failJob({
      job_id: submitted.job.id,
      lock_token: firstClaim?.lock_token ?? '',
      failure_class: 'database',
      message: 'serialization failure',
      retryable: true,
    });

    expect(delayed).toMatchObject({
      status: 'delayed',
      attempts_finished: 1,
      failure_class: 'database',
      next_run_at: '2026-05-20T12:00:05.000Z',
    });
    expect(await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:b',
      lease_ms: 30_000,
    })).toBeNull();

    harness.advance(5_000);
    const secondClaim = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:b',
      lease_ms: 30_000,
    });
    const dead = await harness.service.failJob({
      job_id: submitted.job.id,
      lock_token: secondClaim?.lock_token ?? '',
      failure_class: 'projection_failed',
      message: 'projection snapshot mismatch',
      retryable: true,
    });

    expect(dead).toMatchObject({
      status: 'dead',
      attempts_started: 2,
      attempts_finished: 2,
      failure_class: 'projection_failed',
    });
    expect(await harness.service.listJobEvents(submitted.job.id)).toContainEqual(
      expect.objectContaining({
        event_type: 'job_dead',
        failure_class: 'projection_failed',
      }),
    );
  });

  test('non-retryable failure classes fail closed even when retryable is requested', async () => {
    const harness = createHarness();
    const submitted = await harness.service.enqueueJob({
      name: 'raw-source-read',
      queue: 'maintenance',
      payload_json: { source: 'source:mail' },
      idempotency_key: 'raw-source-read:mail:slot-1',
      max_attempts: 3,
      backoff_type: 'fixed',
      backoff_delay_ms: 5_000,
    });
    const claimed = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:a',
      lease_ms: 30_000,
    });

    const failed = await harness.service.failJob({
      job_id: submitted.job.id,
      lock_token: claimed?.lock_token ?? '',
      failure_class: 'secret_redaction_required',
      message: 'secret-bearing raw source requires redaction',
      retryable: true,
    });

    expect(failed).toMatchObject({
      status: 'dead',
      attempts_finished: 1,
      failure_class: 'secret_redaction_required',
      next_run_at: '2026-05-20T12:00:00.000Z',
    });
  });

  test('timeout moves active job to delayed then dead according to max attempts', async () => {
    const harness = createHarness();
    const submitted = await harness.service.enqueueJob({
      name: 'source-extraction',
      queue: 'maintenance',
      payload_json: { source_id: 'source:mail' },
      idempotency_key: 'source-extraction:mail:slot-1',
      max_attempts: 2,
      backoff_type: 'fixed',
      backoff_delay_ms: 10_000,
      timeout_ms: 1_000,
    });

    await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:timeout',
      lease_ms: 30_000,
    });
    harness.advance(1_001);

    const delayed = await harness.service.sweepTimedOutJobs();
    expect(delayed).toEqual([
      expect.objectContaining({
        id: submitted.job.id,
        status: 'delayed',
        attempts_finished: 1,
        failure_class: 'timeout',
        next_run_at: '2026-05-20T12:00:11.001Z',
      }),
    ]);

    harness.advance(10_000);
    await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:timeout',
      lease_ms: 30_000,
    });
    harness.advance(1_001);

    const dead = await harness.service.sweepTimedOutJobs();
    expect(dead).toEqual([
      expect.objectContaining({
        id: submitted.job.id,
        status: 'dead',
        attempts_finished: 2,
        failure_class: 'timeout',
      }),
    ]);
  });

  test('expired active lock is swept before the full timeout blocks idempotency', async () => {
    const harness = createHarness();
    const submitted = await harness.service.enqueueJob({
      name: 'autopilot_cycle',
      queue: 'maintenance',
      idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
      max_attempts: 1,
      timeout_ms: 60_000,
    });
    await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:crashed',
      lease_ms: 1_000,
    });

    harness.advance(1_001);
    const swept = await harness.service.sweepTimedOutJobs();

    expect(swept).toEqual([
      expect.objectContaining({
        id: submitted.job.id,
        status: 'dead',
        attempts_finished: 1,
        failure_class: 'lock_timeout',
      }),
    ]);
    const replacement = await harness.service.enqueueJob({
      name: 'autopilot_cycle',
      queue: 'maintenance',
      idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
      max_attempts: 1,
    });
    expect(replacement.status).toBe('enqueued');
  });

  test('foreground pressure pauses job claiming', async () => {
    const harness = createHarness({
      foregroundPressure: () => ({ active: true, reason: 'active_mcp_write' }),
    });
    await harness.service.enqueueJob({
      name: 'forgetting-review',
      queue: 'maintenance',
      payload_json: { source: 'source:calendar' },
      idempotency_key: 'forgetting-review:source:calendar:2026-05-20',
      max_attempts: 1,
    });

    expect(await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:a',
      lease_ms: 30_000,
    })).toBeNull();
    expect(await harness.service.listRuntimeEvents()).toContainEqual(
      expect.objectContaining({
        event_type: 'claim_paused_for_foreground_pressure',
        metadata_json: { reason: 'active_mcp_write' },
      }),
    );
  });

  test('cycle lock prevents concurrent write cycles', async () => {
    const harness = createHarness();

    const acquired = await harness.service.acquireCycleLock({
      cycle_name: 'canonical-maintenance-write-cycle',
      holder_pid: 1001,
      holder_host: 'host-a',
      holder_kind: 'worker',
      ttl_ms: 60_000,
    });
    const denied = await harness.service.acquireCycleLock({
      cycle_name: 'canonical-maintenance-write-cycle',
      holder_pid: 1002,
      holder_host: 'host-b',
      holder_kind: 'worker',
      ttl_ms: 60_000,
    });

    expect(acquired).toMatchObject({
      status: 'acquired',
      lock: {
        cycle_name: 'canonical-maintenance-write-cycle',
        holder_pid: 1001,
        ttl_expires_at: '2026-05-20T12:01:00.000Z',
      },
    });
    expect(denied).toMatchObject({
      status: 'busy',
      current_holder: {
        holder_pid: 1001,
        holder_host: 'host-a',
      },
    });

    await harness.service.releaseCycleLock({
      cycle_name: 'canonical-maintenance-write-cycle',
      holder_pid: 1001,
      holder_host: 'host-a',
      holder_kind: 'worker',
    });
    expect(await harness.service.acquireCycleLock({
      cycle_name: 'canonical-maintenance-write-cycle',
      holder_pid: 1002,
      holder_host: 'host-b',
      holder_kind: 'worker',
      ttl_ms: 60_000,
    })).toMatchObject({ status: 'acquired' });
  });

  test('cycle lock release and refresh require matching holder kind', async () => {
    const harness = createHarness();
    await harness.service.acquireCycleLock({
      cycle_name: 'canonical-maintenance-write-cycle',
      holder_pid: 1001,
      holder_host: 'host-a',
      holder_kind: 'worker',
      ttl_ms: 60_000,
    });

    expect(await harness.service.acquireCycleLock({
      cycle_name: 'canonical-maintenance-write-cycle',
      holder_pid: 1001,
      holder_host: 'host-a',
      holder_kind: 'daemon',
      ttl_ms: 60_000,
    })).toMatchObject({
      status: 'busy',
      current_holder: { holder_kind: 'worker' },
    });
    expect(await harness.service.releaseCycleLock({
      cycle_name: 'canonical-maintenance-write-cycle',
      holder_pid: 1001,
      holder_host: 'host-a',
      holder_kind: 'daemon',
    })).toEqual({ status: 'not_holder' });
  });

  test('jobs cannot mutate canonical memory except through a Phase 04 policy callback', async () => {
    const harness = createHarness();
    const submitted = await harness.service.enqueueJob({
      name: 'projection-refresh',
      queue: 'maintenance',
      payload_json: { target: 'systems/mbrain' },
      idempotency_key: 'projection:systems/mbrain:hash-3',
      max_attempts: 1,
    });
    const claimed = await harness.service.claimNextJob({
      queue: 'maintenance',
      worker_id: 'worker:a',
      lease_ms: 30_000,
    });

    await expect(harness.service.writeCanonicalMemoryFromJob({
      job_id: submitted.job.id,
      lock_token: claimed?.lock_token ?? '',
      mutation: {
        target_slug: 'systems/mbrain',
        property: 'compiled_truth.runtime',
        value_json: { text: 'unsafe direct maintenance mutation' },
      },
    })).rejects.toThrow(/Phase 04 canonical write policy/i);
    expect(harness.canonicalMutations).toEqual([]);

    const applied = await harness.service.requestCanonicalWriteFromJob({
      job_id: submitted.job.id,
      lock_token: claimed?.lock_token ?? '',
      policy_request: {
        claim_id: 'extracted-claim:projection-refresh',
        source_refs: ['Source: User, direct message, 2026-05-20 12:00 KST'],
        mutation: {
          target_slug: 'systems/mbrain',
          property: 'compiled_truth.runtime',
          value_json: { text: 'policy-mediated maintenance projection' },
        },
      },
    });

    expect(applied).toMatchObject({
      status: 'applied',
      policy_callback: 'phase04',
      canonical_write_id: 'canonical-write:1',
    });
    expect(harness.canonicalMutations).toEqual([
      expect.objectContaining({
        job_id: submitted.job.id,
        claim_id: 'extracted-claim:projection-refresh',
      }),
    ]);
  });
});

function createHarness(overrides: Partial<MaintenanceRuntimeServiceOptions> = {}) {
  let nowMs = START;
  let id = 0;
  const canonicalMutations: unknown[] = [];
  const service = createMaintenanceRuntimeService({
    now: () => new Date(nowMs).toISOString(),
    nextId: (prefix: string) => `${prefix}:${++id}`,
    canonicalWritePolicy: async (request: unknown) => {
      canonicalMutations.push(request);
      return {
        status: 'applied',
        policy_callback: 'phase04',
        canonical_write_id: `canonical-write:${canonicalMutations.length}`,
      };
    },
    ...overrides,
  });

  return {
    service,
    canonicalMutations,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}
