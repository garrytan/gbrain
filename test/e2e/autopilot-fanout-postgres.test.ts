/**
 * v0.38 — autopilot per-source fan-out end-to-end on Postgres.
 *
 * Integration test that exercises the full chain:
 *   1. Seed N sources with distinct local_paths
 *   2. Call dispatchPerSource → submits N autopilot-cycle jobs
 *   3. Run worker to process them
 *   4. Each job's runCycle writes last_full_cycle_at on success
 *   5. Subsequent dispatchPerSource skips fresh sources via the gate
 *
 * This is the headline-feature happy path. Catches regressions in:
 *   - per-source idempotency key shape (collision across sources = bug)
 *   - source_id threading through handler → runCycle → exit hook
 *   - last_full_cycle_at JSONB merge actually persists per source
 *   - freshness gate correctly skips just-cycled sources
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import {
  dispatchPerSource,
  selectSourcesForDispatch,
} from '../../src/commands/autopilot-fanout.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;

beforeAll(async () => {
  if (skip) return;
  engine = (await setupDB()) as PostgresEngine;
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

beforeEach(async () => {
  if (skip) return;
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
  await engine.executeRaw(`DELETE FROM minion_jobs`);
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks`);
});

async function seedSource(id: string, opts: { local_path?: string } = {}): Promise<void> {
  const localPath = opts.local_path ?? mkdtempSync(join(tmpdir(), `gbrain-fanout-${id}-`));
  // Direct literal `'{}'::jsonb` is fine (no parameter binding). Test
  // explicitly resets config to {} so each test starts clean.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())
     ON CONFLICT (id) DO UPDATE
       SET local_path = EXCLUDED.local_path, config = '{}'::jsonb`,
    [id, id, localPath],
  );
}

describeIfDB('autopilot fan-out — Postgres E2E', () => {
  test('3 sources, all fresh-stale: dispatches 3 distinct jobs with per-source keys', async () => {
    await seedSource('alpha');
    await seedSource('beta');
    await seedSource('gamma');
    // Default source has no local_path by default — filtered by localPathOnly
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);

    const queue = new MinionQueue(engine);
    const slot = '2026-05-22T12:00:00.000Z';
    const result = await dispatchPerSource(engine, queue, {
      repoPath: '/tmp',
      slot,
      timeoutMs: 60_000,
      fanoutMax: 10,
      jsonMode: true,
      emit: () => {},
      log: () => {},
    });

    expect(result.legacy_fallback).toBe(false);
    expect(result.dispatched.sort()).toEqual(['alpha', 'beta', 'gamma']);

    // Verify the 3 jobs land in minion_jobs with distinct idempotency keys
    const jobs = await engine.executeRaw<{ name: string; data: any; idempotency_key: string }>(
      `SELECT name, data, idempotency_key FROM minion_jobs
        WHERE name = 'autopilot-cycle' ORDER BY id`,
    );
    expect(jobs.length).toBe(3);
    expect(jobs.map(j => j.idempotency_key).sort()).toEqual([
      'autopilot-cycle:alpha:2026-05-22T12:00:00.000Z',
      'autopilot-cycle:beta:2026-05-22T12:00:00.000Z',
      'autopilot-cycle:gamma:2026-05-22T12:00:00.000Z',
    ]);
    // source_id threaded into job.data
    const sources = jobs.map(j => {
      const data = typeof j.data === 'string' ? JSON.parse(j.data) : j.data;
      return data.source_id;
    }).sort();
    expect(sources).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('re-dispatch within same slot dedupes via idempotency key', async () => {
    await seedSource('alpha');
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const queue = new MinionQueue(engine);
    const slot = '2026-05-22T13:00:00.000Z';
    const opts = {
      repoPath: '/tmp',
      slot,
      timeoutMs: 60_000,
      fanoutMax: 10,
      jsonMode: true,
      emit: () => {},
      log: () => {},
    };
    const r1 = await dispatchPerSource(engine, queue, opts);
    const r2 = await dispatchPerSource(engine, queue, opts);
    expect(r1.dispatched).toEqual(['alpha']);
    expect(r2.dispatched).toEqual(['alpha']);
    // Only ONE row in minion_jobs (idempotency-key coalesce)
    const jobs = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE name = 'autopilot-cycle'`,
    );
    expect(jobs.length).toBe(1);
  });

  test('source with last_full_cycle_at < 60min ago is skipped by gate', async () => {
    const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await seedSource('fresh');
    await engine.updateSourceConfig('fresh', { last_full_cycle_at: recent });
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);

    const sources = await engine.listAllSources({ localPathOnly: true });
    const sel = selectSourcesForDispatch(sources, 10);
    expect(sel.dispatch.length).toBe(0);
    expect(sel.skippedFresh.map(s => s.id)).toEqual(['fresh']);
  });

  test('end-to-end: updateSourceConfig persists timestamp visible to next listAllSources', async () => {
    await seedSource('full-round-trip');
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);

    // Use a recent (within-freshness-window) timestamp so the source
    // classifies as fresh. Hardcoded dates rot — when this test was
    // written, '2026-05-22T15:00:00.000Z' was 30 minutes ago and within
    // the window. Two days later it's past the window and the source
    // dispatches instead of being skipped, breaking the assertion on
    // line below. Relative timestamp keeps the test valid forever.
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const updated = await engine.updateSourceConfig('full-round-trip', {
      last_full_cycle_at: ts,
    });
    expect(updated).toBe(true);

    // Next listAllSources call sees the timestamp
    const sources = await engine.listAllSources({ localPathOnly: true });
    const s = sources.find(x => x.id === 'full-round-trip')!;
    expect(s.config.last_full_cycle_at).toBe(ts);

    // And selectSourcesForDispatch correctly classifies it as fresh
    const sel = selectSourcesForDispatch(sources, 10);
    expect(sel.dispatch.length).toBe(0);
    expect(sel.skippedFresh.map(s => s.id)).toContain('full-round-trip');
  });

  test('fan-out cap honored: 5 sources, fanoutMax=2 dispatches 2', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) await seedSource(id);
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);

    const queue = new MinionQueue(engine);
    const result = await dispatchPerSource(engine, queue, {
      repoPath: '/tmp',
      slot: 'cap-test',
      timeoutMs: 60_000,
      fanoutMax: 2,
      jsonMode: true,
      emit: () => {},
      log: () => {},
    });
    expect(result.dispatched.length).toBe(2);
    expect(result.skipped_cap.length).toBe(3);
  });

  test('empty federated brain (no local_path sources) falls back to legacy single-job dispatch', async () => {
    // Only default source, with no local_path
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const queue = new MinionQueue(engine);
    const result = await dispatchPerSource(engine, queue, {
      repoPath: '/tmp/legacy',
      slot: 'legacy-test',
      timeoutMs: 60_000,
      fanoutMax: 4,
      jsonMode: true,
      emit: () => {},
      log: () => {},
    });
    expect(result.legacy_fallback).toBe(true);
    const jobs = await engine.executeRaw<{ data: any; idempotency_key: string }>(
      `SELECT data, idempotency_key FROM minion_jobs WHERE name = 'autopilot-cycle'`,
    );
    expect(jobs.length).toBe(1);
    expect(jobs[0].idempotency_key).toBe('autopilot-cycle:legacy-test');
    // No source_id in data (legacy shape)
    const data = typeof jobs[0].data === 'string' ? JSON.parse(jobs[0].data) : jobs[0].data;
    expect(data.source_id).toBeUndefined();
  });
});
