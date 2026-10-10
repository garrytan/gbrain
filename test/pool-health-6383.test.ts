/**
 * #6383: the gbrain side of the pool-health work, without a database.
 *
 * Protects: the in-flight budget derives from the pool's statement_timeout
 * plus `GBRAIN_PG_STUCK_GRACE_MS` and switches off with the timeout or with
 * `0`/`off`; the three warn lines keep the `code= cause= fix= docs=` contract
 * and name a statement by keyword and table only; the stall watch speaks on
 * the second quiet tick and announces recovery once; `/health?deep=1`
 * answers 503 on a probe timeout, on a statement past the pool budget, and
 * while an earlier deep probe is still pending, and 200 with the pool block
 * otherwise.
 */
import { describe, expect, test } from 'bun:test';
import { gucMilliseconds, poolHealthOptions, resolveInflightTimeoutSeconds } from '../src/core/db.ts';
import { withEnv } from './helpers/with-env.ts';
import { formatBuildFailureWarning, formatStuckConnectionWarning, PoolIncidentCounter } from '../src/core/pool-gauge.ts';
import { driverPoolStats, poolHealthSnapshot } from '../src/core/postgres-engine/pool-stats.ts';
import { formatPoolRecoveredInfo, formatPoolStalledWarning, PoolStallWatch } from '../src/core/postgres-engine/pool-stall-watch.ts';
import { probeDeepHealth } from '../src/commands/serve-http-metrics.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('in-flight budget', () => {
  test('gucMilliseconds reads every statement_timeout unit and treats a bare number as milliseconds', () => {
    expect(gucMilliseconds('5min')).toBe(300_000);
    expect(gucMilliseconds('30s')).toBe(30_000);
    expect(gucMilliseconds('1800000')).toBe(1_800_000);
    expect(gucMilliseconds('2h')).toBe(7_200_000);
    expect(gucMilliseconds('500ms')).toBe(500);
    expect(gucMilliseconds('0')).toBeNull();
    expect(gucMilliseconds(undefined)).toBeNull();
    expect(gucMilliseconds('soon')).toBeNull();
  });

  test('resolveInflightTimeoutSeconds is statement_timeout plus a 30 s default grace, in whole seconds', async () => {
    await withEnv({ GBRAIN_PG_STUCK_GRACE_MS: undefined }, async () => {
      expect(resolveInflightTimeoutSeconds('5min')).toBe(330);
      expect(resolveInflightTimeoutSeconds('1800000')).toBe(1830);
    });
    await withEnv({ GBRAIN_PG_STUCK_GRACE_MS: '500' }, async () => {
      expect(resolveInflightTimeoutSeconds('500ms')).toBe(1);
    });
  });

  test('the watchdog is off without a statement timeout and with grace 0 or off', async () => {
    await withEnv({ GBRAIN_PG_STUCK_GRACE_MS: undefined }, async () => { expect(resolveInflightTimeoutSeconds(undefined)).toBeNull(); });
    await withEnv({ GBRAIN_PG_STUCK_GRACE_MS: '0' }, async () => { expect(resolveInflightTimeoutSeconds('5min')).toBeNull(); });
    await withEnv({ GBRAIN_PG_STUCK_GRACE_MS: 'off' }, async () => { expect(resolveInflightTimeoutSeconds('5min')).toBeNull(); });
    await withEnv({ GBRAIN_PG_STUCK_GRACE_MS: 'nonsense' }, async () => { expect(resolveInflightTimeoutSeconds('5min')).toBe(330); });
  });

  test('poolHealthOptions carries the hooks and the budget into postgres.js options', async () => {
    await withEnv({ GBRAIN_PG_STUCK_GRACE_MS: undefined }, async () => {
      const onstuck = () => {};
      const options = poolHealthOptions({ onstuck }, '5min');
      expect(options.onstuck).toBe(onstuck);
      expect(options.onpoisoned).toBeUndefined();
      expect(options.inflight_timeout).toBe(330);
      expect(poolHealthOptions(undefined, undefined).inflight_timeout).toBeNull();
    });
  });
});

describe('warn lines', () => {
  test('pg_connection_stuck names the pool, the age, the queue depth and the statement by keyword and table only', () => {
    const line = formatStuckConnectionWarning('read', { age_ms: 330_412.6, queued: 3, statement: "SELECT p.id FROM pages p WHERE p.slug = $1 AND secret = 'x'" });
    expect(line).toContain('[gbrain] warn code=pg_connection_stuck pool=read age_ms=330413 queued=3 sql=SELECT_pages');
    expect(line).toContain('fix="gbrain doctor --json" docs=docs/ENGINES.md#pg-connection-stuck');
    expect(line).not.toContain('secret');
  });

  test('pg_statement_build_failed names the error code and the statement by keyword and table only', () => {
    const line = formatBuildFailureWarning('direct', 'UNDEFINED_VALUE', 'INSERT INTO mcp_request_log (a, b) VALUES ($1, $2)');
    expect(line).toContain('code=pg_statement_build_failed error=UNDEFINED_VALUE pool=direct sql=INSERT_mcp_request_log');
    expect(formatBuildFailureWarning('read', 'weird code', 'SELECT 1')).toContain('error=BUILD_FAILED');
  });

  test('PoolIncidentCounter counts each kind once per report', () => {
    const counter = new PoolIncidentCounter();
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (line: string) => { lines.push(line); };
    try {
      counter.recordStuck('read', { age_ms: 1, queued: 0, statement: 'SELECT 1' });
      counter.recordBuildFailure('read', 'UNDEFINED_VALUE', 'SELECT $1');
      counter.recordBuildFailure('direct', 'MAX_PARAMETERS_EXCEEDED', 'SELECT $1');
    } finally {
      console.warn = warn;
    }
    expect(counter.stuckCount).toBe(1);
    expect(counter.buildFailureCount).toBe(2);
    expect(lines.filter(l => l.includes('pg_connection_stuck'))).toHaveLength(1);
    expect(lines.filter(l => l.includes('pg_statement_build_failed'))).toHaveLength(2);
  });
});

function fakeEngine(state: { busy: number; queued: number; completed: number; oldest: number; executeRaw?: () => Promise<unknown> }) {
  return {
    kind: 'postgres',
    executeRaw: () => (state.executeRaw ? state.executeRaw() : Promise.resolve([{ '?column?': 1 }])),
    getPoolDiagnostics: () => ({
      tracked: { raw: 0, direct: 0, reserved: 0, tx: 0 },
      poolMax: 4,
      poisonedDiscards: 1,
      stuckDiscards: 2,
      buildFailures: 3,
      prepare: false,
      pool: driverPoolStats({ pool: { max: 4, open: 4 - state.busy, busy: state.busy, full: 0, reserved: 0, connecting: 0, closed: 0, ended: 0, queued: state.queued, inflight_oldest_ms: state.oldest, completed: state.completed } }),
    }),
  } as unknown as BrainEngine;
}

describe('poolHealthSnapshot', () => {
  test('joins the driver numbers with the engine counters, and is null for an engine without pool numbers', () => {
    const snapshot = poolHealthSnapshot(fakeEngine({ busy: 1, queued: 2, completed: 10, oldest: 250 }));
    expect(snapshot).toEqual({ checked_out: 1, max: 4, waiters: 2, inflight_oldest_ms: 250, completed: 10, poisoned_discards: 1, stuck_discards: 2, build_failures: 3 });
    expect(poolHealthSnapshot({ kind: 'pglite' })).toBeNull();
    expect(poolHealthSnapshot({ getPoolDiagnostics: () => { throw new Error('closed'); } })).toBeNull();
  });
});

describe('PoolStallWatch', () => {
  test('stays quiet while statements complete, speaks on the second quiet tick, repeats, and announces recovery once', () => {
    const state = { busy: 1, queued: 0, completed: 10, oldest: 0 };
    const lines: string[] = [];
    let now = 1_000_000;
    const watch = new PoolStallWatch(fakeEngine(state), (line) => lines.push(line), () => now);
    expect(watch.tick()).toBeNull();
    state.completed = 11;
    now += 30_000;
    expect(watch.tick()).toBeNull();
    now += 30_000;
    expect(watch.tick()).toBeNull();
    now += 30_000;
    state.oldest = 90_000;
    expect(watch.tick()).toBe('stalled');
    now += 30_000;
    expect(watch.tick()).toBe('stalled');
    state.completed = 12;
    state.busy = 0;
    now += 30_000;
    expect(watch.tick()).toBe('recovered');
    now += 30_000;
    expect(watch.tick()).toBeNull();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(formatPoolStalledWarning({ checked_out: 1, max: 4, waiters: 0, inflight_oldest_ms: 90_000, completed: 11, poisoned_discards: 1, stuck_discards: 2, build_failures: 3 }, 60_000));
    expect(lines[0]).toContain('code=pg_pool_stalled checked_out=1 max=4 waiters=0 inflight_oldest_ms=90000 completed_delta=0 stalled_ms=60000');
    expect(lines[1]).toContain('stalled_ms=90000');
    expect(lines[2]).toBe(formatPoolRecoveredInfo(120_000, 1));
  });

  test('an idle pool that completes nothing is not a stall', () => {
    const state = { busy: 0, queued: 0, completed: 5, oldest: 0 };
    const lines: string[] = [];
    const watch = new PoolStallWatch(fakeEngine(state), (line) => lines.push(line), () => 0);
    for (let i = 0; i < 5; i++) expect(watch.tick()).toBeNull();
    expect(lines).toEqual([]);
  });

  test('reports nothing for an engine without pool numbers', () => {
    const lines: string[] = [];
    const watch = new PoolStallWatch({ kind: 'pglite' }, (line) => lines.push(line));
    expect(watch.tick()).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe('probeDeepHealth', () => {
  test('200 with the pool block when the pooled SELECT 1 answers and nothing is past budget', async () => {
    const result = await probeDeepHealth(fakeEngine({ busy: 1, queued: 0, completed: 3, oldest: 1200 }), 'postgres', '1.2.3', 100, 330_000);
    expect(result.status).toBe(200);
    if (result.ok) {
      expect(result.body.deep).toBe(true);
      expect(result.body.pool?.inflight_oldest_ms).toBe(1200);
      expect(result.body.pool?.stuck_discards).toBe(2);
      expect(result.body.engine).toBe('postgres');
    }
  });

  test('503 when a statement has waited past the pool budget even though the probe answered', async () => {
    const result = await probeDeepHealth(fakeEngine({ busy: 2, queued: 1, completed: 3, oldest: 400_000 }), 'postgres', '1.2.3', 100, 330_000);
    expect(result.status).toBe(503);
    if (!result.ok) {
      expect(result.body.error_description).toContain('waited 400000 ms');
      expect(result.body.pool?.waiters).toBe(1);
    }
  });

  test('a null budget (watchdog off) skips the age rule', async () => {
    const result = await probeDeepHealth(fakeEngine({ busy: 2, queued: 1, completed: 3, oldest: 400_000 }), 'postgres', '1.2.3', 100, null);
    expect(result.status).toBe(200);
  });

  test('503 when the probe times out, and 503 again while that probe is still pending', async () => {
    let release: () => void = () => {};
    const pending = new Promise<unknown>(resolve => { release = () => resolve([]); });
    const engine = fakeEngine({ busy: 4, queued: 2, completed: 3, oldest: 5000, executeRaw: () => pending });
    const first = await probeDeepHealth(engine, 'postgres', '1.2.3', 20, 330_000);
    expect(first.status).toBe(503);
    if (!first.ok) expect(first.body.error_description).toContain('did not answer within 20 ms');
    const second = await probeDeepHealth(engine, 'postgres', '1.2.3', 20, 330_000);
    expect(second.status).toBe(503);
    if (!second.ok) expect(second.body.error_description).toContain('still pending');
    release();
    await pending;
    await new Promise(r => setTimeout(r, 0));
    const third = await probeDeepHealth(fakeEngine({ busy: 0, queued: 0, completed: 4, oldest: 0 }), 'postgres', '1.2.3', 20, 330_000);
    expect(third.status).toBe(200);
  });

  test('503 when the pooled probe rejects', async () => {
    const result = await probeDeepHealth(fakeEngine({ busy: 0, queued: 0, completed: 0, oldest: 0, executeRaw: () => Promise.reject(new Error('write CONNECTION_STUCK host:5432')) }), 'postgres', '1.2.3', 100, 330_000);
    expect(result.status).toBe(503);
    if (!result.ok) expect(result.body.error_description).toContain('CONNECTION_STUCK');
  });

  test('a PGLite engine answers 200 with a null pool block', async () => {
    const engine = { kind: 'pglite', executeRaw: async () => [] } as unknown as BrainEngine;
    const result = await probeDeepHealth(engine, 'pglite', '1.2.3', 100, null);
    expect(result.status).toBe(200);
    if (result.ok) expect(result.body.pool).toBeNull();
  });
});
