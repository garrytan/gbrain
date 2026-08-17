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
    expect(result.coalesced).toEqual([]);

    // REGRESSION (fan-out preservation): the per-source path now submits with
    // maxPending: 1 — its EXACT source scope must keep N independent caps.
    // If the scope ever regressed to maxWaiting's NULL-as-wildcard shape,
    // sources beta/gamma would coalesce onto alpha's row and this would be 1.
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
    // Honest dispatch surfaces: the second tick coalesced onto the existing
    // row (idempotency fast-path) — it is reported as coalesced, NOT as a
    // dispatch that didn't insert.
    expect(r2.dispatched).toEqual([]);
    expect(r2.coalesced).toEqual(['alpha']);
    // Only ONE row in minion_jobs (idempotency-key coalesce)
    const jobs = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE name = 'autopilot-cycle'`,
    );
    expect(jobs.length).toBe(1);
  });

  test('issue-#2 regression: stalled ACTIVE cycle suppresses cross-slot re-dispatch; dead frees the cap', async () => {
    await seedSource('stuck');
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    // The #2194 failure cooldown is an INDEPENDENT gate: a freshly dead
    // autopilot-cycle row puts the source into backoff, which would mask the
    // property under test (the maxPending CAP freeing on dead). Disable it.
    await engine.setConfig('autopilot.failure_cooldown_min', '0');
    const queue = new MinionQueue(engine);
    const mkOpts = (slot: string) => ({
      repoPath: '/tmp', slot, timeoutMs: 60_000, fanoutMax: 10, jsonMode: true,
      emit: () => {}, log: () => {},
    });

    // Tick 1 dispatches; the job is then claimed and stalls in 'active' with
    // a LIVE lock (worker renewing) — the incident shape.
    const r1 = await dispatchPerSource(engine, queue, mkOpts('slot-A'));
    expect(r1.dispatched).toEqual(['stuck']);
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'active', lock_token = 'stuck-worker',
              lock_until = now() + interval '5 minutes', started_at = now()
        WHERE name = 'autopilot-cycle'`,
    );

    // Tick 2 in a DIFFERENT slot: the rotated idempotency key would have
    // minted a fresh duplicate forever (the ~111-row incident); maxPending
    // now coalesces onto the in-flight active row. Row count stays 1.
    const r2 = await dispatchPerSource(engine, queue, mkOpts('slot-B'));
    expect(r2.dispatched).toEqual([]);
    expect(r2.coalesced).toEqual(['stuck']);
    let rows = await engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'autopilot-cycle'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(1);

    // Dead-letter frees the cap: tick 3 dispatches a fresh row.
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'dead', finished_at = now() WHERE name = 'autopilot-cycle'`,
    );
    const r3 = await dispatchPerSource(engine, queue, mkOpts('slot-C'));
    expect(r3.dispatched).toEqual(['stuck']);
    rows = await engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'autopilot-cycle' AND status = 'waiting'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(1);
  });

  test('recovery loop: legacy NULL-budget row → claim stamps budget → live lock suppresses → expiry frees → stall requeue re-suppresses', async () => {
    // The mechanism test (Codex C9/F3): claim() is driven directly with a
    // token and NO renewer — a live worker would renew the manually expired
    // lock and mask the recovery path.
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const queue = new MinionQueue(engine);
    const mkOpts = (slot: string) => ({
      repoPath: '/tmp/legacy', slot, timeoutMs: 60_000, fanoutMax: 10, jsonMode: true,
      emit: () => {}, log: () => {},
    });

    // Phase 0: a legacy row queued before budget stamping existed.
    const r0 = await dispatchPerSource(engine, queue, mkOpts('rl-slot-0'));
    expect(r0.legacy_fallback).toBe(true);
    await engine.executeRaw(
      `UPDATE minion_jobs SET timeout_ms = NULL, timeout_at = NULL WHERE name = 'autopilot-cycle'`,
    );

    // Phase 1: a REAL claim stamps the handler budget (claim-time fallback)
    // and holds a live lock — dispatch in a new slot coalesces, no insert.
    const claimed = await queue.claim('rl-token', 60_000, 'default', ['autopilot-cycle']);
    expect(claimed).not.toBeNull();
    expect(claimed!.timeout_ms).toBe(30 * 60 * 1000);
    expect(claimed!.timeout_at).not.toBeNull();
    const r1 = await dispatchPerSource(engine, queue, mkOpts('rl-slot-1'));
    expect(r1.dispatched).toEqual([]);
    let rows = await engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'autopilot-cycle'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(1);

    // Phase 2: the worker dies — lock expires without renewal. An
    // expired-lock active must NOT suppress (wedge detectors stay fed):
    // the next slot INSERTS a fresh waiting row.
    await engine.executeRaw(
      `UPDATE minion_jobs SET lock_until = now() - interval '30 seconds'
        WHERE id = $1`, [claimed!.id],
    );
    const r2 = await dispatchPerSource(engine, queue, mkOpts('rl-slot-2'));
    expect(r2.legacy_fallback).toBe(true);
    rows = await engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'autopilot-cycle'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(2);

    // Phase 3: the real sweep requeues the stalled original (max_stalled
    // default 5 → requeue, not dead-letter). Two waiting rows in scope →
    // the next dispatch coalesces onto the newest; no third row.
    const stalled = await queue.handleStalled();
    expect(stalled.requeued.map(j => j.id)).toContain(claimed!.id);
    const requeued = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM minion_jobs WHERE id = $1`, [claimed!.id],
    );
    expect(requeued[0].status).toBe('waiting');
    const r3 = await dispatchPerSource(engine, queue, mkOpts('rl-slot-3'));
    expect(r3.dispatched).toEqual([]);
    rows = await engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'autopilot-cycle'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(2);

    // Phase 4: force the requeued original terminal → single-flight converges
    // (one waiting row remains and still suppresses new dispatch).
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'dead', finished_at = now() WHERE id = $1`, [claimed!.id],
    );
    const r4 = await dispatchPerSource(engine, queue, mkOpts('rl-slot-4'));
    expect(r4.dispatched).toEqual([]);
    rows = await engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'autopilot-cycle' AND status = 'waiting'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(1);
  });

  test('concurrent same-scope submissions hold maxPending: 1 on real Postgres (advisory-lock guarantee)', async () => {
    // PGLite is single-writer, so its Promise.all race is only a smoke test.
    // The postgres.js pool gives genuine concurrent connections — this is
    // the test that actually validates the pg_advisory_xact_lock serialization.
    const queue = new MinionQueue(engine);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        queue.add('race-single-flight', { source_id: 'race-src' }, { maxPending: 1 })),
    );
    const ids = new Set(results.map(r => r.id));
    expect(ids.size).toBe(1);
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'race-single-flight'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(1);
    // Exactly one submission inserted; the other seven carry coalesce metadata.
    expect(results.filter(r => r.coalesced).length).toBe(7);
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
