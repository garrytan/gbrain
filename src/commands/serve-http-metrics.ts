/**
 * Request metrics for `gbrain serve --http` (#3893, reimplemented from
 * @y2688's community PR).
 *
 * In-process counters plus a Prometheus text exposition (format 0.0.4).
 * Kept out of serve-http.ts so the module-size ratchet keeps its teeth; the
 * runServeHttp closure wires exactly three seams:
 *
 *   - `createMetricsCounters()` once per server,
 *   - `app.use(metricsTrackingMiddleware(counters))` BEFORE every route —
 *     Express only applies `app.use` middleware to routes registered after
 *     it (the original PR mounted the tracker after most routes, so they
 *     were never counted),
 *   - `GET /metrics` behind requireAdmin, rendering
 *     `renderPrometheusMetrics(counters)` — request/error/latency series
 *     profile a personal brain's usage, so the exposition is not public.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface MetricsCounters {
  requests: number;
  errors: number;
  latencySamples: number[];
  /** Epoch ms when the counters were created (server start). */
  startedAt: number;
}

// Memory bound for a long-lived daemon: once the buffer exceeds MAX, keep
// only the newest KEEP samples (percentiles then cover a recent window).
const MAX_LATENCY_SAMPLES = 10_000;
const KEEP_LATENCY_SAMPLES = 5_000;

export function createMetricsCounters(now: number = Date.now()): MetricsCounters {
  return { requests: 0, errors: 0, latencySamples: [], startedAt: now };
}

export function recordCompletedRequest(
  counters: MetricsCounters,
  statusCode: number,
  latencyMs: number,
): void {
  if (statusCode >= 400) counters.errors += 1;
  counters.latencySamples.push(latencyMs);
  if (counters.latencySamples.length > MAX_LATENCY_SAMPLES) {
    counters.latencySamples = counters.latencySamples.slice(-KEEP_LATENCY_SAMPLES);
  }
}

export function metricsTrackingMiddleware(counters: MetricsCounters): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Scrapes are excluded so a tight Prometheus interval doesn't skew the
    // request/error ratios it is trying to observe.
    if (req.path === '/metrics') { next(); return; }
    counters.requests += 1;
    const start = Date.now();
    res.on('finish', () => {
      recordCompletedRequest(counters, res.statusCode, Date.now() - start);
    });
    next();
  };
}

export function renderPrometheusMetrics(
  counters: MetricsCounters,
  now: number = Date.now(),
): string {
  const sorted = [...counters.latencySamples].sort((a, b) => a - b);
  const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] ?? 0 : 0;
  const p99 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)] ?? 0 : 0;
  const errorRatio = counters.requests > 0
    ? (counters.errors / counters.requests).toFixed(4)
    : '0';
  const uptimeSeconds = ((now - counters.startedAt) / 1000).toFixed(1);
  return [
    '# HELP gbrain_requests_total Total HTTP requests served.',
    '# TYPE gbrain_requests_total counter',
    `gbrain_requests_total ${counters.requests}`,
    '',
    '# HELP gbrain_errors_total Total HTTP responses with status >= 400.',
    '# TYPE gbrain_errors_total counter',
    `gbrain_errors_total ${counters.errors}`,
    '',
    '# HELP gbrain_error_ratio Errors / requests since server start.',
    '# TYPE gbrain_error_ratio gauge',
    `gbrain_error_ratio ${errorRatio}`,
    '',
    '# HELP gbrain_latency_ms_p50 Request latency p50 (ms) over the retained window.',
    '# TYPE gbrain_latency_ms_p50 gauge',
    `gbrain_latency_ms_p50 ${p50}`,
    '',
    '# HELP gbrain_latency_ms_p99 Request latency p99 (ms) over the retained window.',
    '# TYPE gbrain_latency_ms_p99 gauge',
    `gbrain_latency_ms_p99 ${p99}`,
    '',
    '# HELP gbrain_uptime_seconds Seconds since the HTTP server started.',
    '# TYPE gbrain_uptime_seconds gauge',
    `gbrain_uptime_seconds ${uptimeSeconds}`,
    '',
  ].join('\n');
}
