/**
 * v0.39 behavioral coverage for `gbrain doctor`'s check orchestrator.
 *
 * Drives the exported `buildChecks(engine, args, dbSource): Promise<Check[]>`
 * seam directly (added in v0.39 — extracted from runDoctor's body so the
 * orchestrator is unit-testable without process.exit). Pairs with the
 * subprocess smoke at test/doctor-cli-smoke.test.ts which covers the
 * runDoctor render + exit-code path the seam can't reach in-process.
 *
 * Coverage strategy (D2 — "outcome-shaped + snapshot pin"):
 *   - Snapshot pin the check-name list against a fresh PGLite brain so
 *     accidental check drop-outs during refactors fail loudly with a
 *     reviewable diff at PR time.
 *   - Exercise computeDoctorReport math (3 fails → 60 pts lost, etc.) with
 *     synthesized inputs so the aggregation contract is pinned.
 *   - Honor the --fast flag's skip-set (DB checks absent).
 *   - --json arg is wrapper-only; buildChecks output unaffected.
 *
 * Per-check leaf coverage is deferred to a TODO (see plan): doctor.ts
 * exports 20+ check helpers (whoknowsHealthCheck, takesWeightGridCheck, …)
 * that warrant their own parameterized test file.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  buildChecks,
  computeDoctorReport,
  type Check,
} from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('computeDoctorReport — pure score aggregation', () => {
  test('empty checks → healthy, score 100', () => {
    const r = computeDoctorReport([]);
    expect(r.schema_version).toBe(2);
    expect(r.status).toBe('healthy');
    expect(r.health_score).toBe(100);
    expect(r.checks).toEqual([]);
  });

  test('all ok → healthy, score 100', () => {
    const checks: Check[] = [
      { name: 'a', status: 'ok', message: '' },
      { name: 'b', status: 'ok', message: '' },
      { name: 'c', status: 'ok', message: '' },
    ];
    const r = computeDoctorReport(checks);
    expect(r.status).toBe('healthy');
    expect(r.health_score).toBe(100);
  });

  test('one warn → warnings, -5 points', () => {
    const checks: Check[] = [
      { name: 'a', status: 'ok', message: '' },
      { name: 'b', status: 'warn', message: '' },
    ];
    const r = computeDoctorReport(checks);
    expect(r.status).toBe('warnings');
    expect(r.health_score).toBe(95);
  });

  test('one fail → unhealthy, -20 points', () => {
    const r = computeDoctorReport([{ name: 'a', status: 'fail', message: '' }]);
    expect(r.status).toBe('unhealthy');
    expect(r.health_score).toBe(80);
  });

  test('3 fails → unhealthy, -60 points (audit-driver math)', () => {
    const checks: Check[] = [
      { name: 'a', status: 'fail', message: '' },
      { name: 'b', status: 'fail', message: '' },
      { name: 'c', status: 'fail', message: '' },
    ];
    const r = computeDoctorReport(checks);
    expect(r.status).toBe('unhealthy');
    expect(r.health_score).toBe(40);
  });

  test('mixed ok + warn + fail → unhealthy (fail dominates)', () => {
    const r = computeDoctorReport([
      { name: 'a', status: 'ok', message: '' },
      { name: 'b', status: 'warn', message: '' },
      { name: 'c', status: 'fail', message: '' },
    ]);
    // 1 fail (-20) + 1 warn (-5) = 75; fail status dominates ranking.
    expect(r.status).toBe('unhealthy');
    expect(r.health_score).toBe(75);
  });

  test('score is clamped at 0 (never negative)', () => {
    const many: Check[] = Array.from({ length: 10 }, (_, i) => ({
      name: `f${i}`,
      status: 'fail' as const,
      message: '',
    }));
    const r = computeDoctorReport(many);
    expect(r.health_score).toBe(0);
    expect(r.status).toBe('unhealthy');
  });
});

describe('buildChecks — orchestrator against PGLite', () => {
  test('returns a non-empty Check[] against a fresh brain', async () => {
    const checks = await buildChecks(engine, []);
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(10);
    // Every check has the contracted shape.
    for (const c of checks) {
      expect(typeof c.name).toBe('string');
      expect(['ok', 'warn', 'fail']).toContain(c.status);
      expect(typeof c.message).toBe('string');
    }
  });

  test('snapshot: load-bearing check names always run against a fresh brain', async () => {
    // Behavior-preservation snapshot (D6 lock). Pinning a CURATED subset of
    // load-bearing checks rather than the full list so this test stays stable
    // when new checks land deliberately — but breaks loudly if a known
    // load-bearing check accidentally drops out during a refactor.
    //
    // Deliberately tight set: only checks whose code path is unconditional
    // given an engine + has no env / config dependencies that vary between
    // test processes. Adding more sensitive checks here (e.g. ones that
    // read process.env) caused cross-shard flakes under the parallel runner.
    // Per-check leaf coverage is the TODO that targets the broader surface.
    const checks = await buildChecks(engine, []);
    const names = new Set(checks.map(c => c.name));
    const loadBearing = [
      'connection',
      'schema_version',
      'brain_score',
      'sync_freshness',
      'search_mode',
      'eval_drift',
      'reranker_health',
      'embedding_width_consistency',
      'autopilot_lock_scope',
    ];
    // NOTE: sync_failures and slug_fallback_audit are deliberately NOT in
    // the load-bearing set — they're only pushed when the corresponding
    // JSONL file exists. Tests run on isolated tmpdir GBRAIN_HOMEs where
    // those files may or may not exist depending on which sibling tests
    // already wrote audit lines.
    const missing = loadBearing.filter(n => !names.has(n));
    expect(missing, `load-bearing checks missing from buildChecks result: ${missing.join(', ')}`).toEqual([]);
    // Plus a minimum total count — drops below ~30 means something
    // bigger went wrong than the snapshot can name.
    expect(checks.length).toBeGreaterThan(30);
  });

  test('--fast skips DB-dependent checks; filesystem checks still run', async () => {
    // Fast-mode bails out of the DB section entirely. When an engine is
    // available, the early-return skips pushing a connection check (no
    // probe happened); when engine is null AND --fast, a warn-status
    // synthesized connection check is added. Filesystem checks above
    // the DB phase always run.
    const checks = await buildChecks(engine, ['--fast']);
    const names = new Set(checks.map(c => c.name));
    // DB-dependent checks should NOT be present.
    expect(names.has('schema_version')).toBe(false);
    expect(names.has('brain_score')).toBe(false);
    expect(names.has('sync_freshness')).toBe(false);
    // Filesystem checks above the DB phase still ran.
    expect(names.has('resolver_health')).toBe(true);

    // The null-engine + --fast path DOES synthesize a connection warn.
    const fsOnlyChecks = await buildChecks(null, ['--fast'], 'env:DATABASE_URL');
    const fsOnlyNames = new Set(fsOnlyChecks.map(c => c.name));
    expect(fsOnlyNames.has('connection')).toBe(true);
    const conn = fsOnlyChecks.find(c => c.name === 'connection')!;
    expect(conn.status).toBe('warn');
    expect(conn.message.toLowerCase()).toContain('fast');
  });

  test('--json arg does NOT alter the returned check list', async () => {
    // --json is a wrapper-level concern (controls outputResults render mode);
    // the buildChecks seam should return the same checks regardless.
    const without = await buildChecks(engine, []);
    const withJson = await buildChecks(engine, ['--json']);
    expect(withJson.map(c => c.name)).toEqual(without.map(c => c.name));
  });

  test('returns partial check list when engine is null (no early process.exit)', async () => {
    // Pre-v0.39 the no-engine path called outputResults + process.exit
    // directly. Post-extract it returns the partial list so the wrapper
    // decides exit code. This is the load-bearing assertion that proves
    // the early-exit refactor preserved observable behavior.
    const checks = await buildChecks(null, []);
    expect(Array.isArray(checks)).toBe(true);
    const connection = checks.find(c => c.name === 'connection');
    expect(connection).toBeDefined();
    expect(connection!.status).toBe('warn');
  });

  test('mixed-outcome render path: synthesized checks aggregate as expected', () => {
    // The orchestrator's render path (outputResults in the wrapper) reads
    // the same DoctorReport.status enum we compute here. Pin the
    // ok+warn+fail aggregation so the wrapper's render of a real mixed
    // brain state is reproducible.
    const mixed: Check[] = [
      { name: 'resolver_health', status: 'ok', message: '50 skills' },
      { name: 'sync_failures', status: 'warn', message: '2 unacked' },
      { name: 'schema_version', status: 'fail', message: 'mid-upgrade' },
    ];
    const r = computeDoctorReport(mixed);
    expect(r.status).toBe('unhealthy');
    expect(r.health_score).toBe(75);
    expect(r.checks).toHaveLength(3);
    expect(r.checks.map(c => c.status)).toEqual(['ok', 'warn', 'fail']);
  });
});
