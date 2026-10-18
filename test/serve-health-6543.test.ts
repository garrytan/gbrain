/**
 * #6543 (A5r, A5x): `/health?deep=1` names why serve is unhealthy and what its
 * transport is, and the opt-in exit lets a supervisor restart a wedged serve.
 *
 * Protects: a real persistence consumer driven to restart_required (an
 * abandoned preparation past the ceiling) makes the deep probe answer 503
 * `persistence_restart_required` before it runs its SELECT 1, with no request
 * id in the unauthenticated body (it answered 200 before: the probe only read
 * the pool); every 503 carries a stable `code`, `fix` and `docs`; the
 * transport block reports the live pool's prepare and max_pipeline with the
 * reason, the startup statement_timeout, `session_timeouts_not_applied` with
 * the doctor probe's ALTER ROLE fix whenever a configured timeout reads 0
 * (whatever the env URL says), and a Supavisor application_name;
 * `GBRAIN_SERVE_RESTART_REQUIRED_EXIT_SECONDS` refuses values under 120, is off when
 * unset, exits 69 only after restart_required has held continuously for the
 * window (the hold restarts when the flag clears, as it does when the stuck
 * work settles), never exits on a statement past the in-flight budget, and
 * exits even when cleanup never finishes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { driverPoolStats } from '../src/core/postgres-engine/pool-stats.ts';
import { probeDeepHealth } from '../src/commands/serve-http-metrics.ts';
import { formatServeTransportLine, installRestartRequiredExit, readServeTransport, recordServeTransport, resolveRestartRequiredExitSeconds, selfExitSuppressed, serveTransport } from '../src/commands/serve-health.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { SERVE_UNHEALTHY_EXIT_CODE } from '../src/core/exit-codes.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

interface FakeState { oldest?: number; overBudget?: number; applied?: string; appName?: string; prepare?: boolean; maxPipeline?: number; url?: string; executeRaw?: () => Promise<unknown>; disconnect?: () => Promise<void> }
function fakeEngine(state: FakeState = {}) {
  const probes: string[] = [];
  const engine = {
    kind: 'postgres',
    _savedConfig: state.url ? { database_url: state.url } : undefined,
    sql: { options: { prepare: state.prepare ?? true, max_pipeline: state.maxPipeline ?? 100 } },
    executeRaw: (sql: string) => {
      probes.push(sql);
      if (state.executeRaw) return state.executeRaw();
      if (sql === 'SHOW statement_timeout') return Promise.resolve([{ statement_timeout: state.applied ?? '5min' }]);
      if (sql === 'SHOW application_name') return Promise.resolve([{ application_name: state.appName ?? 'gbrain' }]);
      return Promise.resolve([{ '?column?': 1 }]);
    },
    disconnect: state.disconnect ?? (() => Promise.resolve()),
    getPoolDiagnostics: () => ({
      poisonedDiscards: 0, stuckDiscards: 0, buildFailures: 0, desyncDiscards: 0,
      pool: driverPoolStats({ pool: { max: 4, open: 3, busy: 1, full: 0, reserved: 0, connecting: 0, closed: 0, ended: 0, queued: 0, inflight_oldest_ms: state.oldest ?? 0, completed: 1, ...(state.overBudget !== undefined ? { inflight_over_budget_ms: state.overBudget } : {}) } }),
    }),
  } as unknown as BrainEngine;
  return { engine, probes };
}
const healthy = () => ({ restart_required: false });
const ledgerDir = mkdtempSync(join(tmpdir(), 'gbrain-serve-self-exit-'));
const ledger = (name: string) => join(ledgerDir, `${name}-${randomUUID().slice(0, 8)}.json`);
afterAll(() => rmSync(ledgerDir, { recursive: true, force: true }));
const ENV = { GBRAIN_STATEMENT_TIMEOUT: undefined, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined, PGMAX_PIPELINE: undefined, GBRAIN_PREPARE: undefined };

describe('a real consumer at restart_required', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-serve-health-6543-'));
  const config: HarnessConfig = {
    kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
    seed: 6543, schedules: 0, operations: 0, sourceIds: ['serve-health'], principalIds: [randomUUID()],
  };
  const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
  let engine: PGLiteEngine;
  beforeAll(async () => withEnv(env, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    selectFixtureHost(config.hostId);
    await initializeFixtures(engine, config);
  }), 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

  test('deep health answers 503 persistence_restart_required before its probe, without the request id; the exit fires after a continuous hold and resets when the zombie settles', async () => withEnv(env, async () => {
    const sources = await fixtures(engine, config);
    const stuck = await admitWrite(engine, admission(config, sources[0]!, 'health/stuck', 'stuck body'));
    const never = Promise.withResolvers<ReturnType<typeof prepared>>();
    const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => never.promise,
      { hostId: config.hostId, pollMs: 20, preparationMs: 30, preparationBudgets: { maxAttempts: 3, ceilingMs: 200 }, onError: () => {} });
    const status = () => consumer.status();
    const { engine: served, probes } = fakeEngine();
    try {
      consumer.start();
      await waitFor(() => consumer.restartRequired(), { timeoutMs: 5_000, label: 'the abandoned preparation passes the ceiling' });

      const result = await probeDeepHealth(served, 'postgres', '1.2.3', 100, 330_000, status);
      if (result.ok) throw new Error('expected 503');
      expect(result.body).toMatchObject({ code: 'persistence_restart_required', docs: 'docs/ENGINES.md#serve-deep-health' });
      expect(result.body.fix).toContain('GBRAIN_SERVE_RESTART_REQUIRED_EXIT_SECONDS');
      expect(probes).toEqual([]);
      expect(JSON.stringify(result.body)).not.toContain(stuck.request_id);
      expect(JSON.stringify(result.body)).not.toContain(stuck.id);

      let now = 0;
      const fired: number[] = [];
      const firing = installRestartRequiredExit(served, 120, { ledgerPath: ledger('real'), now: () => now, consumerStatus: status, exit: code => fired.push(code), log: () => {}, everyMs: 3_600_000 });
      try {
        firing.check(); now = 120_000; firing.check();
        await waitFor(() => fired.length > 0, { timeoutMs: 2_000, label: 'the held restart_required exits' });
        expect(fired).toEqual([SERVE_UNHEALTHY_EXIT_CODE]);
      } finally { firing.stop(); }

      now = 0;
      const exits: number[] = [];
      const watch = installRestartRequiredExit(served, 120, { ledgerPath: ledger('real'), now: () => now, consumerStatus: status, exit: code => exits.push(code), log: () => {}, everyMs: 3_600_000 });
      try {
        watch.check();
        now = 100_000; watch.check();
        never.resolve(prepared(stuck, sources));
        await waitFor(() => !consumer.restartRequired(), { timeoutMs: 5_000, label: 'the zombie settles and restart_required clears' });
        now = 130_000; watch.check();
        expect(exits).toEqual([]);
        expect((await probeDeepHealth(served, 'postgres', '1.2.3', 100, 330_000, status)).status).toBe(200);
      } finally { watch.stop(); }
    } finally {
      never.resolve(prepared(stuck, sources));
      await consumer.stop();
      await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0]! }, stuck.request_id).catch(() => {});
    }
  }), 30_000);
});

describe('/health?deep=1 codes', () => {
  test('503 pool_inflight_over_budget names the restart and PGMAX_PIPELINE=0 in its fix', async () => {
    const result = await probeDeepHealth(fakeEngine({ oldest: 400_000 }).engine, 'postgres', '1.2.3', 100, 330_000, healthy);
    if (result.ok) throw new Error('expected 503');
    expect(result.body.code).toBe('pool_inflight_over_budget');
    expect(result.body.fix).toContain('Restart this gbrain serve');
    expect(result.body.fix).toContain('PGMAX_PIPELINE=0');
    expect(result.body.fix).toContain('transport');
  });

  test('#6543 A4: with per-statement budgets, a long statement within its own declared budget is not over budget; one past it is', async () => {
    const declared = await probeDeepHealth(fakeEngine({ oldest: 900_000, overBudget: 0 }).engine, 'postgres', '1.2.3', 100, 330_000, healthy);
    expect(declared.ok).toBe(true);
    expect(declared.body.pool).toMatchObject({ inflight_oldest_ms: 900_000, inflight_over_budget_ms: 0 });
    const past = await probeDeepHealth(fakeEngine({ oldest: 900_000, overBudget: 900_000 }).engine, 'postgres', '1.2.3', 100, 330_000, healthy);
    if (past.ok) throw new Error('expected 503');
    expect(past.body.code).toBe('pool_inflight_over_budget');
  });

  test('a probe that times out or fails carries deep_health_probe_failed with its reason', async () => {
    const timedOut = await probeDeepHealth(fakeEngine({ executeRaw: () => new Promise(() => {}) }).engine, 'postgres', '1.2.3', 20, 330_000, healthy);
    if (timedOut.ok) throw new Error('expected 503');
    expect(timedOut.body).toMatchObject({ code: 'deep_health_probe_failed', reason: 'timeout' });
    const failed = await probeDeepHealth(fakeEngine({ executeRaw: () => Promise.reject(new Error('boom')) }).engine, 'postgres', '1.2.3', 100, 330_000, healthy);
    if (failed.ok) throw new Error('expected 503');
    expect(failed.body).toMatchObject({ code: 'deep_health_probe_failed', reason: 'error' });
  });

  test('a healthy serve answers 200 with a null transport until startup recorded one; with no consumer running it is healthy too', async () => {
    const result = await probeDeepHealth(fakeEngine().engine, 'postgres', '1.2.3', 100, 330_000, healthy);
    expect(result.status).toBe(200);
    if (result.ok) expect(result.body.transport).toBeNull();
    expect((await probeDeepHealth(fakeEngine().engine, 'postgres', '1.2.3', 100, 330_000)).status).toBe(200);
  });
});

describe('transport block', () => {
  test('a configured timeout that reads 0: session_timeouts_not_applied with the ALTER ROLE fix, the live pool options and their reason, Supavisor named', async () => withEnv(ENV, async () => {
    const { engine } = fakeEngine({ applied: '0', prepare: false, maxPipeline: 0, appName: 'Supavisor', url: 'postgresql://u:p@db.example.invalid:6543/d' });
    expect(await readServeTransport(engine)).toEqual({ pooler_mode: 'transaction', prepare: false, max_pipeline: 0, max_pipeline_reason: 'transaction_pooler_port',
      statement_timeout: '0', session_timeouts_not_applied: true, fix: "ALTER ROLE <gbrain role> SET statement_timeout = '5min'", application_name: 'Supavisor' });
    const lines: string[] = [];
    await recordServeTransport(engine, line => lines.push(line));
    expect(lines).toEqual([formatServeTransportLine(serveTransport(engine)!)]);
    expect(lines[0]).toContain('transport pooler_mode=transaction prepare=false max_pipeline=0 max_pipeline_reason=transaction_pooler_port statement_timeout=0 application_name=Supavisor session_timeouts_not_applied=true');
    expect(lines[0]).toContain("ALTER ROLE <gbrain role> SET statement_timeout = '5min'");
    const result = await probeDeepHealth(engine, 'postgres', '1.2.3', 100, 330_000, healthy);
    if (!result.ok) throw new Error('expected 200');
    expect(result.body.transport).toMatchObject({ max_pipeline: 0, session_timeouts_not_applied: true });
  }));

  test('the live pool wins over the URL: a 0 reading flags the timeout even with no pooler URL in the environment, and the pool reports what it really runs', async () => withEnv(ENV, async () => {
    const transport = await readServeTransport(fakeEngine({ applied: '0', prepare: true, maxPipeline: 7, url: 'postgresql://u:p@db.example.invalid:5432/d?max_pipeline=7' }).engine);
    expect(transport).toMatchObject({ pooler_mode: 'session_or_direct', prepare: true, max_pipeline: 7, max_pipeline_reason: 'url_max_pipeline', session_timeouts_not_applied: true });
  }));

  test('a direct server that applies the timeout reports it and no flag', async () => withEnv(ENV, async () => {
    const transport = await readServeTransport(fakeEngine({ applied: '5min', url: 'postgresql://u:p@db.example.invalid:5432/d' }).engine);
    expect(transport).toEqual({ pooler_mode: 'session_or_direct', prepare: true, max_pipeline: 100, max_pipeline_reason: 'default', statement_timeout: '5min', session_timeouts_not_applied: false });
    expect(formatServeTransportLine(transport)).toBe('[gbrain serve] transport pooler_mode=session_or_direct prepare=true max_pipeline=100 max_pipeline_reason=default statement_timeout=5min');
  }));
});

describe('GBRAIN_SERVE_RESTART_REQUIRED_EXIT_SECONDS', () => {
  test('unset, empty or 0 is off; 120 and up is accepted; anything else is refused with invalid_params', () => {
    expect(resolveRestartRequiredExitSeconds(undefined)).toBeNull();
    expect(resolveRestartRequiredExitSeconds('')).toBeNull();
    expect(resolveRestartRequiredExitSeconds('0')).toBeNull();
    expect(resolveRestartRequiredExitSeconds('120')).toBe(120);
    expect(resolveRestartRequiredExitSeconds(' 600 ')).toBe(600);
    for (const bad of ['119', '30', '-5', 'abc', '1.5e3']) {
      expect(() => resolveRestartRequiredExitSeconds(bad)).toThrow(expect.objectContaining({ code: 'invalid_params' }));
    }
    expect(() => resolveRestartRequiredExitSeconds('60')).toThrow(/at least 120/);
  });

  test('exits 69 once restart_required has held continuously for the window; a clear restarts the hold; cleanup runs first', async () => {
    let now = 0;
    let restart = true;
    const exits: number[] = [];
    const lines: string[] = [];
    let disconnected = 0;
    const { engine } = fakeEngine({ disconnect: async () => { disconnected++; } });
    const watch = installRestartRequiredExit(engine, 120, { ledgerPath: ledger('fake'), now: () => now, consumerStatus: () => ({ restart_required: restart }), exit: code => exits.push(code), log: line => lines.push(line), everyMs: 3_600_000 });
    try {
      watch.check();
      now = 60_000; watch.check();
      restart = false; now = 90_000; watch.check();
      restart = true; now = 100_000; watch.check();
      now = 219_000; watch.check();
      expect(exits).toEqual([]);
      now = 220_000; watch.check();
      await waitFor(() => exits.length > 0, { timeoutMs: 2_000 });
      expect(exits).toEqual([SERVE_UNHEALTHY_EXIT_CODE]);
      expect(SERVE_UNHEALTHY_EXIT_CODE).toBe(69);
      expect(disconnected).toBe(1);
      expect(lines[0]).toContain('code=serve_unhealthy_exit cause=persistence_restart_required held_s=120 exit=69');
      now = 400_000; watch.check();
      expect(exits).toHaveLength(1);
    } finally { watch.stop(); }
  });

  test('cleanup that never finishes (a consumer stop waiting on the stuck work) still exits 69 at the cleanup deadline, once', async () => {
    let now = 0;
    const exits: number[] = [];
    const lines: string[] = [];
    const { engine } = fakeEngine({ disconnect: () => new Promise<void>(() => {}) });
    const watch = installRestartRequiredExit(engine, 120, { ledgerPath: ledger('fake'), now: () => now, consumerStatus: () => ({ restart_required: true }), exit: code => exits.push(code), log: line => lines.push(line), everyMs: 3_600_000, cleanupDeadlineMs: 30 });
    try {
      watch.check(); now = 120_000; watch.check();
      expect(exits).toEqual([]);
      await waitFor(() => exits.length > 0, { timeoutMs: 2_000, label: 'the cleanup deadline forces the exit' });
      expect(exits).toEqual([SERVE_UNHEALTHY_EXIT_CODE]);
      expect(lines.some(line => line.includes('cleanup deadline (30 ms) exceeded'))).toBe(true);
      await Bun.sleep(50);
      expect(exits).toHaveLength(1);
    } finally { watch.stop(); }
  });

  test('loop guard: each exit is recorded durably; with 3 self-exits in the last hour serve logs serve_self_exit_suppressed, keeps serving and deep health reports it; a clear lifts it', async () => {
    const path = ledger('guard');
    const wall = Date.parse('2026-10-12T12:00:00.000Z');
    const minutesAgo = (m: number) => new Date(wall - m * 60_000).toISOString();
    writeFileSync(path, JSON.stringify({ exits: [minutesAgo(90), minutesAgo(40), minutesAgo(20)] }));
    let now = 0;
    let restart = true;
    const exits: number[] = [];
    const { engine } = fakeEngine();
    const first = installRestartRequiredExit(engine, 120, { ledgerPath: path, wallNow: () => wall, now: () => now, consumerStatus: () => ({ restart_required: restart }), exit: code => exits.push(code), log: () => {}, everyMs: 3_600_000 });
    try {
      first.check(); now = 120_000; first.check();
      await waitFor(() => exits.length > 0, { timeoutMs: 2_000 });
      expect(exits).toEqual([SERVE_UNHEALTHY_EXIT_CODE]);
    } finally { first.stop(); }
    // The 90-minute-old exit aged out; this one was added: 3 within the hour now.
    expect((JSON.parse(readFileSync(path, 'utf8')) as { exits: string[] }).exits).toEqual([minutesAgo(40), minutesAgo(20), new Date(wall).toISOString()]);

    const lines: string[] = [];
    const exits2: number[] = [];
    const { engine: next } = fakeEngine();
    now = 0;
    const second = installRestartRequiredExit(next, 120, { ledgerPath: path, wallNow: () => wall + 60_000, now: () => now, consumerStatus: () => ({ restart_required: restart }), exit: code => exits2.push(code), log: line => lines.push(line), everyMs: 3_600_000 });
    try {
      second.check(); now = 120_000; second.check(); now = 240_000; second.check();
      await Bun.sleep(20);
      expect(exits2).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('code=serve_self_exit_suppressed cause=persistence_restart_required self_exits_last_hour=3');
      expect(selfExitSuppressed(next)).toBe(true);
      const result = await probeDeepHealth(next, 'postgres', '1.2.3', 100, 330_000, () => ({ restart_required: restart }));
      if (result.ok) throw new Error('expected 503');
      expect(result.body).toMatchObject({ code: 'persistence_restart_required', self_exit_suppressed: true });
      expect(result.body.fix).toStartWith('self_exit_suppressed:');
      restart = false; second.check();
      expect(selfExitSuppressed(next)).toBe(false);
    } finally { second.stop(); }
  });

  test('a statement past the in-flight budget never triggers the exit, nor does a healthy consumer', () => {
    let now = 0;
    const exits: number[] = [];
    const watch = installRestartRequiredExit(fakeEngine({ oldest: 10_000_000 }).engine, 120, { ledgerPath: ledger('budget'), now: () => now, consumerStatus: healthy, exit: code => exits.push(code), log: () => {}, everyMs: 3_600_000 });
    try { for (let i = 0; i < 10; i++) { now += 60_000; watch.check(); } } finally { watch.stop(); }
    expect(exits).toEqual([]);
  });
});
