/**
 * /metrics surface for `gbrain serve --http` (#3893, reimplemented from
 * @y2688's PR).
 *
 * Two properties the original community PR got wrong are pinned here:
 *
 *   1. The tracking middleware must be registered BEFORE every route —
 *      Express only applies `app.use` middleware to routes registered after
 *      it, and the PR mounted the tracker after most routes, so they were
 *      never counted (structural test below).
 *   2. GET /metrics must sit behind requireAdmin — request/error/latency
 *      series profile a personal brain's usage, so the exposition is not a
 *      public surface (the PR served it unauthenticated).
 *
 * The helpers are exercised against a bare Express app wired in the SAME
 * order as serve-http.ts (precedent: the mountOAuthCorsGate tests in
 * test/serve-http-cors.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import {
  createMetricsCounters,
  metricsTrackingMiddleware,
  recordCompletedRequest,
  renderPrometheusMetrics,
  type MetricsCounters,
} from '../src/commands/serve-http-metrics.ts';

describe('recordCompletedRequest', () => {
  test('classifies status >= 400 as errors and records latency samples', () => {
    const c = createMetricsCounters(1_000);
    recordCompletedRequest(c, 200, 12);
    recordCompletedRequest(c, 404, 5);
    recordCompletedRequest(c, 500, 30);
    expect(c.errors).toBe(2);
    expect(c.latencySamples).toEqual([12, 5, 30]);
  });

  test('caps the latency buffer, keeping the newest samples (memory bound)', () => {
    const c = createMetricsCounters();
    for (let i = 0; i <= 10_000; i++) recordCompletedRequest(c, 200, i);
    expect(c.latencySamples.length).toBe(5_000);
    expect(c.latencySamples[c.latencySamples.length - 1]).toBe(10_000);
    expect(c.latencySamples[0]).toBe(5_001);
  });
});

describe('renderPrometheusMetrics', () => {
  test('renders counters, ratio, percentiles, and uptime in exposition format', () => {
    const c = createMetricsCounters(0);
    c.requests = 10;
    c.errors = 2;
    c.latencySamples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const text = renderPrometheusMetrics(c, 5_000);
    expect(text).toContain('# TYPE gbrain_requests_total counter');
    expect(text).toContain('gbrain_requests_total 10');
    expect(text).toContain('gbrain_errors_total 2');
    expect(text).toContain('gbrain_error_ratio 0.2000');
    expect(text).toContain('gbrain_latency_ms_p50 51');
    expect(text).toContain('gbrain_latency_ms_p99 100');
    expect(text).toContain('gbrain_uptime_seconds 5.0');
  });

  test('zero-state renders without dividing by zero', () => {
    const c = createMetricsCounters(0);
    const text = renderPrometheusMetrics(c, 0);
    expect(text).toContain('gbrain_requests_total 0');
    expect(text).toContain('gbrain_error_ratio 0');
    expect(text).toContain('gbrain_latency_ms_p50 0');
    expect(text).toContain('gbrain_latency_ms_p99 0');
  });
});

describe('metricsTrackingMiddleware — Express wiring (serve-http.ts order)', () => {
  function buildApp(counters: MetricsCounters, opts: { authed: boolean }): express.Express {
    const app = express();
    // Mirrors serve-http.ts: tracker first, then routes.
    app.use(metricsTrackingMiddleware(counters));
    const adminGate = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (opts.authed) { next(); return; }
      res.status(401).json({ error: 'Admin authentication required' });
    };
    app.get('/metrics', adminGate, (_req, res) => {
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(renderPrometheusMetrics(counters));
    });
    app.get('/ok', (_req, res) => res.json({ ok: true }));
    app.get('/boom', (_req, res) => res.status(500).json({ boom: true }));
    return app;
  }

  async function withServer<T>(
    app: express.Express,
    fn: (base: string) => Promise<T>,
  ): Promise<T> {
    const server: Server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  test('counts requests on routes registered after it; 5xx lands as an error', async () => {
    const counters = createMetricsCounters();
    await withServer(buildApp(counters, { authed: true }), async base => {
      await fetch(`${base}/ok`);
      await fetch(`${base}/boom`);
      expect(counters.requests).toBe(2);
      expect(counters.errors).toBe(1);
      expect(counters.latencySamples.length).toBe(2);
    });
  });

  test('/metrics scrapes are excluded from the counters they report', async () => {
    const counters = createMetricsCounters();
    await withServer(buildApp(counters, { authed: true }), async base => {
      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('gbrain_requests_total 0');
      expect(counters.requests).toBe(0);
    });
  });

  test('an unauthenticated scrape gets 401, not the exposition', async () => {
    const counters = createMetricsCounters();
    await withServer(buildApp(counters, { authed: false }), async base => {
      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('gbrain_requests_total');
    });
  });
});

describe('serve-http.ts wiring (structural — the two defects of the original PR)', () => {
  // test-reads-source-ok: mount ORDER (middleware before first route) and the requireAdmin
  // gate are wiring properties of the real serve-http.ts; the behavioral tests above run a
  // rebuilt harness app, so only a source scan pins the real module without booting it.
  const src = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf-8');

  test('tracking middleware is mounted before the first route registration', () => {
    const mw = src.indexOf('metricsTrackingMiddleware(');
    const firstTokenRoute = src.indexOf("app.post('/token'");
    const authRouterMount = src.indexOf('app.use(authRouter)');
    expect(mw).toBeGreaterThan(-1);
    expect(firstTokenRoute).toBeGreaterThan(-1);
    expect(authRouterMount).toBeGreaterThan(-1);
    expect(mw).toBeLessThan(firstTokenRoute);
    expect(mw).toBeLessThan(authRouterMount);
  });

  test('GET /metrics is gated behind requireAdmin', () => {
    expect(src).toMatch(/app\.get\(\s*'\/metrics',\s*requireAdmin/);
  });
});
