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
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  submitEmbedBackfill,
  COOLDOWN_CONFIG_KEY,
  SPEND_CAP_CONFIG_KEY,
} from '../src/core/embed-backfill-submit.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000); // 30s — PGLite WASM cold-start + 89 migrations exceeds 5s default

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Surgical reset (mirrors test/minions.test.ts) — full TRUNCATE wipes the
  // config table's `version` key that MinionQueue.ensureSchema() reads.
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('submitEmbedBackfill — happy path', () => {
  test('submits with priority 5 + idempotency key on a clean source', async () => {
    const result = await submitEmbedBackfill(engine, 'default', { reason: 'unit' });
    expect(result.status).toBe('submitted');
    expect(result.jobId).toBeDefined();

    const queue = new MinionQueue(engine);
    const job = await queue.getJob(result.jobId!);
    expect(job).not.toBeNull();
    expect(job!.name).toBe('embed-backfill');
    expect(job!.priority).toBe(5);
    expect((job!.data as { sourceId: string }).sourceId).toBe('default');
  });

  test('respects opts.priority override', async () => {
    const result = await submitEmbedBackfill(engine, 'default', {
      reason: 'unit',
      priority: -10,
    });
    expect(result.status).toBe('submitted');
    const queue = new MinionQueue(engine);
    const job = await queue.getJob(result.jobId!);
    expect(job!.priority).toBe(-10);
  });
});

describe('submitEmbedBackfill — cooldown gate', () => {
  test('blocks re-submission while a same-source job is active', async () => {
    const queue = new MinionQueue(engine);
    // Seed an active job manually
    await queue.add('embed-backfill', { sourceId: 'default' }, {});
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='active' WHERE name='embed-backfill'`,
    );

    const result = await submitEmbedBackfill(engine, 'default', { reason: 'unit' });
    expect(result.status).toBe('cooldown');
    expect(result.cooldownRemainingSeconds).toBeUndefined();
  });

  test('blocks re-submission inside the cooldown window after recent finish', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('embed-backfill', { sourceId: 'default' }, {});
    // Mark completed 1 minute ago
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='completed', finished_at=NOW() - INTERVAL '1 minute' WHERE id=$1`,
      [job.id],
    );

    const result = await submitEmbedBackfill(engine, 'default', {
      reason: 'unit',
      cooldownMinOverride: 10, // 10min cooldown; 1min elapsed → blocked
    });
    expect(result.status).toBe('cooldown');
    expect(result.cooldownRemainingSeconds).toBeGreaterThan(0);
    expect(result.cooldownRemainingSeconds).toBeLessThanOrEqual(10 * 60);
  });

  test('allows re-submission after cooldown elapses', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('embed-backfill', { sourceId: 'default' }, {});
    // Mark completed 11 minutes ago — past the 10-min cooldown
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='completed', finished_at=NOW() - INTERVAL '11 minutes' WHERE id=$1`,
      [job.id],
    );

    const result = await submitEmbedBackfill(engine, 'default', {
      reason: 'unit',
      cooldownMinOverride: 10,
    });
    expect(result.status).toBe('submitted');
  });

  test('config-overridable cooldown (via embed.backfill_cooldown_min)', async () => {
    await engine.setConfig(COOLDOWN_CONFIG_KEY, '60'); // 60min cooldown
    const queue = new MinionQueue(engine);
    const job = await queue.add('embed-backfill', { sourceId: 'default' }, {});
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='completed', finished_at=NOW() - INTERVAL '30 minutes' WHERE id=$1`,
      [job.id],
    );

    const result = await submitEmbedBackfill(engine, 'default', { reason: 'unit' });
    expect(result.status).toBe('cooldown');
  });
});

describe('submitEmbedBackfill — 24h spend cap', () => {
  test('refuses when spend24hFn returns >= cap', async () => {
    const result = await submitEmbedBackfill(engine, 'default', {
      reason: 'unit',
      spendCapUsdOverride: 25,
      spend24hFn: async () => 25,
    });
    expect(result.status).toBe('spend_capped');
    expect(result.spend24hUsd).toBe(25);
    expect(result.spendCapUsd).toBe(25);
  });

  test('admits when spend24hFn returns < cap', async () => {
    const result = await submitEmbedBackfill(engine, 'default', {
      reason: 'unit',
      spendCapUsdOverride: 25,
      spend24hFn: async () => 24.99,
    });
    expect(result.status).toBe('submitted');
  });

  test('config-overridable spend cap (via embed.backfill_max_usd_per_source_24h)', async () => {
    await engine.setConfig(SPEND_CAP_CONFIG_KEY, '5');
    const result = await submitEmbedBackfill(engine, 'default', {
      reason: 'unit',
      spend24hFn: async () => 5,
    });
    expect(result.status).toBe('spend_capped');
    expect(result.spendCapUsd).toBe(5);
  });
});

describe('submitEmbedBackfill — source isolation', () => {
  test('cooldown is per-source, not global', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{"federated":true}') ON CONFLICT (id) DO NOTHING`,
    );
    const queue = new MinionQueue(engine);
    // Active job on 'default'
    await queue.add('embed-backfill', { sourceId: 'default' }, {});
    await engine.executeRaw(`UPDATE minion_jobs SET status='active' WHERE name='embed-backfill'`);

    // Submit for 'other' — should NOT be blocked
    const result = await submitEmbedBackfill(engine, 'other', { reason: 'unit' });
    expect(result.status).toBe('submitted');
  });
});
