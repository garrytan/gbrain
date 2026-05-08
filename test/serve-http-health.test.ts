/**
 * Tests for probeHealth(), probeLiveness(), and HEALTH_TIMEOUT_MS in
 * src/commands/serve-http.ts.
 *
 * v0.28.10 split: /health now calls probeLiveness (sql`SELECT 1`); the heavier
 * probeHealth (engine.getStats()) moved behind requireAdmin at
 * /admin/api/full-stats. Both share ProbeHealthResult so the route handlers
 * stay 2-line dispatches.
 *
 * Calls each probe directly with a mock — no Express test client, no module
 * mocking. Each probe gets happy / timeout / db-error coverage.
 *
 * Express-layer wiring (timeout actually propagates through the route, body
 * shape after JSON serialization) is covered by /health + /admin/api/full-stats
 * cases in test/e2e/serve-http-oauth.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { HEALTH_TIMEOUT_MS, probeHealth, probeLiveness } from '../src/commands/serve-http.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SqlQuery } from '../src/core/oauth-provider.ts';

/**
 * Minimal mock engine: only `getStats()` is exercised by probeHealth.
 * Cast to BrainEngine is safe — probeHealth doesn't touch other methods.
 */
function makeMockEngine(getStats: () => Promise<unknown>): BrainEngine {
  return { getStats } as unknown as BrainEngine;
}

/**
 * Minimal mock sql tag: probeLiveness only awaits the result of `sql\`SELECT 1\``
 * — the tag function's return value is what's raced, success/throw is what
 * matters. We ignore the template strings and simulate a connection by calling
 * the supplied factory.
 */
function makeMockSql(fn: () => Promise<unknown>): SqlQuery {
  const tag: any = (_strings: TemplateStringsArray, ..._values: unknown[]) => fn();
  return tag as SqlQuery;
}

describe('HEALTH_TIMEOUT_MS', () => {
  test('exported as 3000 (Fly.io headroom over the 5s default)', () => {
    expect(HEALTH_TIMEOUT_MS).toBe(3000);
  });
});

describe('probeHealth', () => {
  test('happy path: returns 200 + status:ok + spread stats', async () => {
    const engine = makeMockEngine(async () => ({ pages: 42, links: 10 }));
    const result = await probeHealth(engine, 'pglite', '0.27.1', 100);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    if (result.ok) {
      expect(result.body.status).toBe('ok');
      expect(result.body.version).toBe('0.27.1');
      expect(result.body.engine).toBe('pglite');
      expect(result.body.pages).toBe(42);
      expect(result.body.links).toBe(10);
    }
  });

  test('timeout path: getStats() hangs forever → 503 with health_timeout description within 1s', async () => {
    const engine = makeMockEngine(() => new Promise(() => { /* never resolves */ }));
    const start = Date.now();
    const result = await probeHealth(engine, 'pglite', '0.27.1', 100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    if (!result.ok) {
      expect(result.body.error).toBe('service_unavailable');
      expect(result.body.error_description).toBe(
        'Health check timed out (database pool may be saturated)',
      );
    }
  });

  test('db-error path: getStats() rejects → 503 with database_failed description', async () => {
    const engine = makeMockEngine(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await probeHealth(engine, 'postgres', '0.27.1', 100);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    if (!result.ok) {
      expect(result.body.error).toBe('service_unavailable');
      expect(result.body.error_description).toBe('Database connection failed');
    }
  });
});

describe('probeLiveness (v0.28.10)', () => {
  test('happy path: returns 200 + status:ok with NO engine-stats fields', async () => {
    const sql = makeMockSql(async () => [{ '?column?': 1 }]);
    const result = await probeLiveness(sql, 'postgres', '0.28.10', 100);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    if (result.ok) {
      expect(result.body.status).toBe('ok');
      expect(result.body.version).toBe('0.28.10');
      expect(result.body.engine).toBe('postgres');
      // Regression: the lightweight body must NOT spread getStats() fields.
      // The original PR's pre-refactor /health leaked page_count etc.;
      // tightening this assertion is the iron-rule regression test.
      expect(Object.keys(result.body).sort()).toEqual(['engine', 'status', 'version']);
      expect((result.body as Record<string, unknown>).page_count).toBeUndefined();
      expect((result.body as Record<string, unknown>).chunk_count).toBeUndefined();
    }
  });

  test('timeout path: sql hangs → 503 with health_timeout description within 1s', async () => {
    const sql = makeMockSql(() => new Promise(() => { /* never resolves */ }));
    const start = Date.now();
    const result = await probeLiveness(sql, 'postgres', '0.28.10', 100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    if (!result.ok) {
      expect(result.body.error).toBe('service_unavailable');
      expect(result.body.error_description).toBe(
        'Health check timed out (database pool may be saturated)',
      );
    }
  });

  test('db-error path: sql throws → 503 with database_failed description', async () => {
    const sql = makeMockSql(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await probeLiveness(sql, 'postgres', '0.28.10', 100);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    if (!result.ok) {
      expect(result.body.error).toBe('service_unavailable');
      expect(result.body.error_description).toBe('Database connection failed');
    }
  });

  test('timer-cleanup: 100 fast successful probes do not leak pending timers', async () => {
    const sql = makeMockSql(async () => [{ '?column?': 1 }]);
    // Snapshot active handles before; same after. If the finally-block
    // clearTimeout regressed, every probe would leak a 100ms-pending timer.
    const beforeHandles = (process as any)._getActiveHandles?.()?.length ?? 0;
    await Promise.all(
      Array.from({ length: 100 }, () => probeLiveness(sql, 'postgres', '0.28.10', 100)),
    );
    // Allow microtask + process tick drain to let any leaked timers settle.
    await new Promise(r => setImmediate(r));
    const afterHandles = (process as any)._getActiveHandles?.()?.length ?? 0;
    // Loose bound: bun's internal handles can drift by a small amount across
    // many fetches; we only care that we don't ramp by ~100 leaked timers.
    expect(afterHandles - beforeHandles).toBeLessThan(20);
  });
});
