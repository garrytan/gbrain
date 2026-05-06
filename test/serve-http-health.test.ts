/**
 * Tests for probeHealth() and HEALTH_TIMEOUT_MS in src/commands/serve-http.ts.
 *
 * Calls probeHealth() directly with a mock engine — no Express test client,
 * no module mocking. Three branches of the route (happy / timeout / db-error)
 * each get a unit test, plus a sanity assertion on the exported constant.
 *
 * Express-layer wiring (timeout actually propagates through the route, body
 * shape after JSON serialization) is covered by the new /health timeout case
 * in test/e2e/serve-http-oauth.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { HEALTH_TIMEOUT_MS, probeHealth } from '../src/commands/serve-http.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * Minimal mock engine: only `getStats()` is exercised by probeHealth.
 * Cast to BrainEngine is safe — probeHealth doesn't touch other methods.
 */
function makeMockEngine(getStats: () => Promise<unknown>): BrainEngine {
  return { getStats } as unknown as BrainEngine;
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
