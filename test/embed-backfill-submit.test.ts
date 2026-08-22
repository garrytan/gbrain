/**
 * Tests for src/core/embed-backfill-submit.ts (v0.40 D19).
 *
 * Validates the submission gate layer:
 *   - Default path: submits with priority 5 + idempotency bucket
 *   - Cooldown: refuses re-submission inside the window
 *   - Active-job: refuses while a same-source job is active/waiting
 *   - 24h spend cap: refuses when accumulated spend >= cap
 *   - Config overrides honored (per-test cap + cooldown)
 *   - Override knobs in opts honored (test seam)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  submitEmbedBackfill,
  COOLDOWN_CONFIG_KEY,
  SPEND_CAP_CONFIG_KEY,
  type SubmitEmbedBackfillResult,
  type SubmitEmbedBackfillOpts,
} from '../src/core/embed-backfill-submit.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { embedBackfillWorkerSurface } from '../src/core/minions/embed-backfill-admission.ts';

let engine: PGLiteEngine;
let workerBackedEngine: BrainEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  workerBackedEngine = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'kind') return 'postgres';
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}, 30000); // 30s — PGLite WASM cold-start + 89 migrations exceeds 5s default

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Surgical reset (mirrors test/minions.test.ts) — full TRUNCATE wipes the
  // config table's `version` key that MinionQueue.ensureSchema() reads.
  await engine.executeRaw('DELETE FROM minion_jobs');
});

function submitWithWorker(
  sourceId: string,
  opts: SubmitEmbedBackfillOpts,
) {
  return submitEmbedBackfill(workerBackedEngine, sourceId, opts);
}

function expectStatus<S extends SubmitEmbedBackfillResult['status']>(
  result: SubmitEmbedBackfillResult,
  status: S,
): asserts result is Extract<SubmitEmbedBackfillResult, { status: S }> {
  expect(result.status).toBe(status);
}

function failOnAccessPglite(): { engine: BrainEngine; accesses: string[] } {
  const accesses: string[] = [];
  const fail = (name: string) => async () => {
    accesses.push(name);
    throw new Error(`unexpected engine access: ${name}`);
  };
  return {
    engine: {
      kind: 'pglite',
      getConfig: fail('getConfig'),
      executeRaw: fail('executeRaw'),
      transaction: fail('transaction'),
    } as unknown as BrainEngine,
    accesses,
  };
}

describe('submitEmbedBackfill — worker-surface gate', () => {
  test('automatic refusal happens before config, SQL, or transaction access', async () => {
    const fake = failOnAccessPglite();

    const result = await submitEmbedBackfill(fake.engine, 'default', { reason: 'unit' });

    expect(result).toEqual({ status: 'no_worker_surface', engineKind: 'pglite' });
    expect(fake.accesses).toEqual([]);
  });

  test('refuses PGLite without leaving an undrainable waiting job', async () => {
    const result = await submitEmbedBackfill(engine, 'default', { reason: 'unit' });

    expect(result).toEqual({
      status: 'no_worker_surface',
      engineKind: 'pglite',
    });
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM minion_jobs
        WHERE name = 'embed-backfill'`,
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  test('public queue refuses before config, SQL, or transaction access', async () => {
    const fake = failOnAccessPglite();

    await expect(
      new MinionQueue(fake.engine).add('embed-backfill', { sourceId: 'default' }),
    ).rejects.toThrow('PGLite has no persistent worker');
    expect(fake.accesses).toEqual([]);
  });

  test('public queue refusal leaves no PGLite row', async () => {
    await expect(
      new MinionQueue(engine).add('embed-backfill', { sourceId: 'default' }),
    ).rejects.toThrow('gbrain embed --stale --source default');
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM minion_jobs WHERE name = 'embed-backfill'`,
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  test('public refusal rejects a metacharacter source id without rendering a paste-ready command', async () => {
    const fake = failOnAccessPglite();
    let error: Error | undefined;
    try {
      await new MinionQueue(fake.engine).add('embed-backfill', {
        sourceId: 'default; printf injected',
      });
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain('Invalid source_id');
    expect(error!.message).not.toContain('Run `gbrain embed --stale --source');
    expect(fake.accesses).toEqual([]);

    const response = await dispatchToolCall(
      engine,
      'submit_job',
      { name: 'embed-backfill', data: { sourceId: 'default; printf injected' } },
      { remote: true, transport: 'stdio', sourceId: 'default' },
    );
    expect(response.isError).toBe(true);
    const envelope = JSON.parse(response.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(envelope).toMatchObject({ error: 'invalid_params' });
    expect(envelope.message).not.toContain('gbrain embed --stale --source');
  });

  test('an unknown future engine kind fails closed before any engine access', async () => {
    const fake = failOnAccessPglite();
    const futureEngine = new Proxy(fake.engine, {
      get(target, prop) {
        if (prop === 'kind') return 'future-engine';
        return Reflect.get(target, prop, target);
      },
    }) as unknown as BrainEngine;

    expect(embedBackfillWorkerSurface(futureEngine)).toEqual({
      status: 'no_worker_surface',
      engineKind: 'unknown',
    });
    await expect(
      new MinionQueue(futureEngine).add('embed-backfill', { sourceId: 'default' }),
    ).rejects.toMatchObject({ code: 'no_worker_surface', engineKind: 'unknown' });
    expect(fake.accesses).toEqual([]);
  });

  test('submit_job refuses before engine access and MCP leaves no row', async () => {
    const fake = failOnAccessPglite();
    const submitJob = operationsByName.submit_job;
    await expect(submitJob.handler({
      engine: fake.engine,
      config: {},
      logger: console,
      dryRun: false,
      remote: true,
    } as never, { name: 'embed-backfill', data: { sourceId: 'default' } })).rejects.toThrow(
      'PGLite has no persistent worker',
    );
    expect(fake.accesses).toEqual([]);

    const response = await dispatchToolCall(
      engine,
      'submit_job',
      { name: 'embed-backfill', data: { sourceId: 'default' } },
      { remote: true, transport: 'stdio', sourceId: 'default' },
    );
    expect(response.isError).toBe(true);
    const envelope = JSON.parse(response.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(envelope).toMatchObject({
      error: 'no_worker_surface',
      suggestion: 'Run `gbrain embed --stale --source default` to drain embeddings inline.',
    });
    expect(envelope.message).toContain('PGLite has no persistent worker');
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM minion_jobs WHERE name = 'embed-backfill'`,
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  test('submit_job dry-run reports the same no-worker capability refusal without access or a row', async () => {
    const fake = failOnAccessPglite();
    const submitJob = operationsByName.submit_job;
    await expect(submitJob.handler({
      engine: fake.engine,
      config: {},
      logger: console,
      dryRun: true,
      remote: true,
    } as never, { name: 'embed-backfill', data: { sourceId: 'default' } })).rejects.toMatchObject({
      code: 'no_worker_surface',
    });
    expect(fake.accesses).toEqual([]);

    const response = await dispatchToolCall(
      engine,
      'submit_job',
      { name: 'embed-backfill', data: { sourceId: 'default' }, dry_run: true },
      { remote: true, transport: 'stdio', sourceId: 'default' },
    );
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]?.text ?? '{}')).toMatchObject({
      error: 'no_worker_surface',
    });
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM minion_jobs WHERE name = 'embed-backfill'`,
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  test('worker-backed public queue still accepts embed-backfill', async () => {
    const job = await new MinionQueue(workerBackedEngine).add(
      'embed-backfill',
      { sourceId: 'default' },
    );
    expect(job.status).toBe('waiting');
  });
});

describe('submitEmbedBackfill — happy path', () => {
  test('submits with priority 5 + idempotency key on a clean source', async () => {
    const result = await submitWithWorker('default', { reason: 'unit' });
    expectStatus(result, 'submitted');
    expect(result.jobId).toBeDefined();
    expect(result.spendCapBypassed).toBe(false);

    const queue = new MinionQueue(workerBackedEngine);
    const job = await queue.getJob(result.jobId!);
    expect(job).not.toBeNull();
    expect(job!.name).toBe('embed-backfill');
    expect(job!.priority).toBe(5);
    expect((job!.data as { sourceId: string }).sourceId).toBe('default');
  });

  test('respects opts.priority override', async () => {
    const result = await submitWithWorker('default', {
      reason: 'unit',
      priority: -10,
    });
    expectStatus(result, 'submitted');
    const queue = new MinionQueue(workerBackedEngine);
    const job = await queue.getJob(result.jobId!);
    expect(job!.priority).toBe(-10);
  });
});

describe('submitEmbedBackfill — cooldown gate', () => {
  test('blocks re-submission while a same-source job is active', async () => {
    const queue = new MinionQueue(workerBackedEngine);
    // Seed an active job manually
    await queue.add('embed-backfill', { sourceId: 'default' }, {});
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='active' WHERE name='embed-backfill'`,
    );

    const result = await submitWithWorker('default', { reason: 'unit' });
    expectStatus(result, 'cooldown');
    expect(result).toEqual({
      status: 'cooldown',
      reason: 'active_or_waiting',
      cooldownRemainingSeconds: null,
    });
  });

  test('blocks re-submission inside the cooldown window after recent finish', async () => {
    const queue = new MinionQueue(workerBackedEngine);
    const job = await queue.add('embed-backfill', { sourceId: 'default' }, {});
    // Mark completed 1 minute ago
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='completed', finished_at=NOW() - INTERVAL '1 minute' WHERE id=$1`,
      [job.id],
    );

    const result = await submitWithWorker('default', {
      reason: 'unit',
      cooldownMinOverride: 10, // 10min cooldown; 1min elapsed → blocked
    });
    expectStatus(result, 'cooldown');
    expect(result.reason).toBe('recently_finished');
    expect(result.cooldownRemainingSeconds).toBeGreaterThan(0);
    expect(result.cooldownRemainingSeconds).toBeLessThanOrEqual(10 * 60);
  });

  test('allows re-submission after cooldown elapses', async () => {
    const queue = new MinionQueue(workerBackedEngine);
    const job = await queue.add('embed-backfill', { sourceId: 'default' }, {});
    // Mark completed 11 minutes ago — past the 10-min cooldown
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='completed', finished_at=NOW() - INTERVAL '11 minutes' WHERE id=$1`,
      [job.id],
    );

    const result = await submitWithWorker('default', {
      reason: 'unit',
      cooldownMinOverride: 10,
    });
    expectStatus(result, 'submitted');
  });

  test('config-overridable cooldown (via embed.backfill_cooldown_min)', async () => {
    await engine.setConfig(COOLDOWN_CONFIG_KEY, '60'); // 60min cooldown
    const queue = new MinionQueue(workerBackedEngine);
    const job = await queue.add('embed-backfill', { sourceId: 'default' }, {});
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='completed', finished_at=NOW() - INTERVAL '30 minutes' WHERE id=$1`,
      [job.id],
    );

    const result = await submitWithWorker('default', { reason: 'unit' });
    expectStatus(result, 'cooldown');
  });
});

describe('submitEmbedBackfill — 24h spend cap', () => {
  test('refuses when spend24hFn returns >= cap', async () => {
    const result = await submitWithWorker('default', {
      reason: 'unit',
      spendCapUsdOverride: 25,
      spend24hFn: async () => 25,
    });
    expectStatus(result, 'spend_capped');
    expect(result.spend24hUsd).toBe(25);
    expect(result.spendCapUsd).toBe(25);
  });

  test('admits when spend24hFn returns < cap', async () => {
    const result = await submitWithWorker('default', {
      reason: 'unit',
      spendCapUsdOverride: 25,
      spend24hFn: async () => 24.99,
    });
    expectStatus(result, 'submitted');
  });

  test('config-overridable spend cap (via embed.backfill_max_usd_per_source_24h)', async () => {
    await engine.setConfig(SPEND_CAP_CONFIG_KEY, '5');
    const result = await submitWithWorker('default', {
      reason: 'unit',
      spend24hFn: async () => 5,
    });
    expectStatus(result, 'spend_capped');
    expect(result.spendCapUsd).toBe(5);
  });

  // v0.42.42.0 (#2139): off-switch + tokenmax bypass.
  test('cap "off" → submits even at huge spend (Infinity cap never tripped)', async () => {
    await engine.setConfig(SPEND_CAP_CONFIG_KEY, 'off');
    const result = await submitWithWorker('default', {
      reason: 'unit',
      spend24hFn: async () => 1e9,
    });
    expectStatus(result, 'submitted');
  });

  test('0 falls back to the default cap (off semantics ≠ 0)', async () => {
    await engine.setConfig(SPEND_CAP_CONFIG_KEY, '0');
    const result = await submitWithWorker('default', {
      reason: 'unit',
      spend24hFn: async () => 25, // == default $25 → capped
    });
    expectStatus(result, 'spend_capped');
    expect(result.spendCapUsd).toBe(25);
  });

  test('spend.posture=tokenmax bypasses the cap, marks spendCapBypassed', async () => {
    const result = await submitWithWorker('default', {
      reason: 'unit',
      postureOverride: 'tokenmax',
      spendCapUsdOverride: 25,
      spend24hFn: async () => 100, // way over cap
    });
    expectStatus(result, 'submitted');
    expect(result.spendCapBypassed).toBe(true);
    if (!result.spendCapBypassed) throw new Error('expected spend-cap bypass payload');
    expect(result.spend24hUsd).toBe(100);
  });

  test('tokenmax does NOT bypass the cooldown (axis split — churn protection stays)', async () => {
    const queue = new MinionQueue(workerBackedEngine);
    const job = await queue.add('embed-backfill', { sourceId: 'default' }, {});
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='completed', finished_at=NOW() - INTERVAL '1 minute' WHERE id=$1`,
      [job.id],
    );
    const result = await submitWithWorker('default', {
      reason: 'unit',
      postureOverride: 'tokenmax',
      cooldownMinOverride: 10,
      spend24hFn: async () => 1e9,
    });
    expectStatus(result, 'cooldown'); // posture lifts the cap, NOT the cooldown
  });
});

describe('submitEmbedBackfill — source isolation', () => {
  test('cooldown is per-source, not global', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{"federated":true}') ON CONFLICT (id) DO NOTHING`,
    );
    const queue = new MinionQueue(workerBackedEngine);
    // Active job on 'default'
    await queue.add('embed-backfill', { sourceId: 'default' }, {});
    await engine.executeRaw(`UPDATE minion_jobs SET status='active' WHERE name='embed-backfill'`);

    // Submit for 'other' — should NOT be blocked
    const result = await submitWithWorker('other', { reason: 'unit' });
    expectStatus(result, 'submitted');
  });
});
