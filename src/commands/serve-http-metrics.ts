/**
 * Request metrics and health probes for `gbrain serve --http` (#3893,
 * reimplemented from @y2688's community PR).
 *
 * In-process counters plus a Prometheus text exposition (format 0.0.4).
 * Kept out of serve-http.ts so the module-size ratchet keeps its teeth;
 * buildServeHttpApp wires exactly three metrics seams:
 *
 *   - `createMetricsCounters()` once per server,
 *   - `app.use(metricsTrackingMiddleware(counters))` BEFORE every route —
 *     Express only applies `app.use` middleware to routes registered after
 *     it (the original PR mounted the tracker after most routes, so they
 *     were never counted),
 *   - `GET /metrics` behind requireAdmin (`mountMetrics`), rendering
 *     `renderPrometheusMetrics(counters)` — request/error/latency series
 *     profile a personal brain's usage, so the exposition is not public.
 *
 * `mountHealth` serves the public liveness probe; `probeHealth` backs the
 * admin-only full-stats endpoint.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { BrainEngine } from '../core/engine.ts';
import { resolveInflightTimeoutSeconds, resolveSessionTimeouts } from '../core/db.ts';
import { poolHealthSnapshot, type PoolHealthSnapshot } from '../core/postgres-engine/pool-stats.ts';
import { VERSION } from '../version.ts';
import type { ServeHttpContext } from './serve-http.ts';

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

/**
 * /health endpoint timeout. 3s rather than 5s: Fly.io's default
 * health-check timeout is 5s, so returning 503 right at the orchestrator
 * deadline races with the orchestrator recording the request as a timeout.
 * 3s leaves 2s of headroom for TCP, response framing, and clock skew.
 */
export const HEALTH_TIMEOUT_MS = 3000;

export type ProbeHealthResult =
  | { ok: true; status: 200; body: { status: 'ok'; version: string; engine: string; [k: string]: unknown } }
  | { ok: false; status: 503; body: { error: 'service_unavailable'; error_description: string } };

/**
 * Pure async health probe. Races `engine.getStats()` against a timeout,
 * returns a tagged result. No Express coupling — easy to unit-test with a
 * mock engine. The /health route handler is a thin wrapper around this.
 */
export async function probeHealth(
  engine: BrainEngine,
  engineName: string,
  version: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<ProbeHealthResult> {
  // Capture the handle so we can clearTimeout when getStats() wins. Without
  // this, every fast /health request leaves a 3s pending timer in the event
  // loop until it fires — under high probe rates this builds up a rolling
  // backlog of timers and avoidable wakeups. Both adversarial reviewers
  // (Claude + Codex) flagged this independently.
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const stats = await Promise.race([
      engine.getStats(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('health_timeout')), timeoutMs);
      }),
    ]);
    return {
      ok: true,
      status: 200,
      body: { status: 'ok', version, engine: engineName, ...stats },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return {
      ok: false,
      status: 503,
      body: {
        error: 'service_unavailable',
        error_description: msg === 'health_timeout'
          ? 'Health check timed out (database pool may be saturated)'
          : 'Database connection failed',
      },
    };
  } finally {
    // Clear the timer regardless of which branch won the race. No-op when
    // the timer already fired (we're in the timeout-rejection catch block).
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Races an abortable `SELECT 1` against `probeHealth`'s timeout; Postgres
 * cancels the losing query while PGLite only discards its eventual result.
 */
export async function probeLiveness(
  engine: BrainEngine,
  engineName: string,
  version: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<ProbeHealthResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  try {
    await Promise.race([
      engine.executeRaw('SELECT 1', undefined, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('health_timeout'));
        }, timeoutMs);
      }),
    ]);
    return {
      ok: true,
      status: 200,
      body: { status: 'ok', version, engine: engineName },
    };
  } catch (e: unknown) {
    const msg = controller.signal.aborted ? 'health_timeout' : (e instanceof Error ? e.message : 'unknown');
    return {
      ok: false,
      status: 503,
      body: {
        error: 'service_unavailable',
        error_description: msg === 'health_timeout'
          ? 'Health check timed out (database pool may be saturated)'
          : 'Database connection failed',
      },
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * #6383: why `/health` answered 200 through a 50-minute wedge: `probeLiveness`
 * runs its `SELECT 1` on a reserved connection, and `reserve()` only ever
 * claims an idle one, while the wedged connections sat in the driver's busy
 * queue where ordinary handler statements are routed. `/health?deep=1` runs
 * the probe through that ordinary pooled dispatch (no reservation) and reads
 * the pool's own numbers; it answers 503 when the probe does not return within
 * its budget, when a statement has waited past the read pool's in-flight
 * budget, or when the previous deep probe is still pending. One deep probe is
 * in flight per engine at a time, so a stuck one is never joined by a pile.
 */
export type DeepHealthResult =
  | { ok: true; status: 200; body: { status: 'ok'; deep: true; version: string; engine: string; probe_ms: number; pool: PoolHealthSnapshot | null } }
  | { ok: false; status: 503; body: { error: 'service_unavailable'; error_description: string; deep: true; pool: PoolHealthSnapshot | null } };

const pendingDeepProbes = new WeakMap<object, Promise<unknown>>();

/** The read pool's in-flight budget in ms (statement_timeout + grace), or null when the watchdog is off. */
export function readPoolInflightBudgetMs(): number | null {
  const seconds = resolveInflightTimeoutSeconds(resolveSessionTimeouts().statement_timeout);
  return seconds === null ? null : seconds * 1000;
}

export async function probeDeepHealth(
  engine: BrainEngine,
  engineName: string,
  version: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
  budgetMs: number | null = readPoolInflightBudgetMs(),
): Promise<DeepHealthResult> {
  const pool = () => poolHealthSnapshot(engine);
  const unavailable = (why: string): DeepHealthResult => ({ ok: false, status: 503, body: { error: 'service_unavailable', error_description: why, deep: true, pool: pool() } });
  if (pendingDeepProbes.has(engine)) return unavailable('Deep health probe still pending from an earlier request (a pooled SELECT 1 has not answered)');
  const started = Date.now();
  const probe = engine.executeRaw('SELECT 1');
  pendingDeepProbes.set(engine, probe);
  probe.then(() => pendingDeepProbes.delete(engine), () => pendingDeepProbes.delete(engine));
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      probe,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('health_timeout')), timeoutMs); }),
    ]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return unavailable(msg === 'health_timeout'
      ? `Deep health probe timed out: a pooled SELECT 1 did not answer within ${timeoutMs} ms`
      : `Deep health probe failed: ${msg}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  const snapshot = pool();
  if (snapshot && budgetMs !== null && snapshot.inflight_oldest_ms > budgetMs) {
    return unavailable(`A pooled statement has waited ${snapshot.inflight_oldest_ms} ms for the server, past the pool budget of ${budgetMs} ms`);
  }
  return { ok: true, status: 200, body: { status: 'ok', deep: true, version, engine: engineName, probe_ms: Date.now() - started, pool: snapshot } };
}

/** GET /health: liveness only (full stats are the admin-only /admin/api/full-stats); `?deep=1` probes through the ordinary pool. */
export function mountHealth(app: Express, ctx: ServeHttpContext): void {
  const { engine, config } = ctx;
  // ---------------------------------------------------------------------------
  // Health check — liveness only. Full engine stats live at
  // /admin/api/full-stats (requireAdmin). See probeLiveness above for the why.
  // ---------------------------------------------------------------------------
  app.get('/health', async (req, res) => {
    const deep = req.query.deep;
    const result = deep === '1' || deep === 'true'
      ? await probeDeepHealth(engine, config.engine || 'pglite', VERSION)
      : await probeLiveness(engine, config.engine || 'pglite', VERSION);
    res.status(result.status).json(result.body);
  });
}

/** GET /metrics behind requireAdmin. */
export function mountMetrics(app: Express, ctx: ServeHttpContext): void {
  const { requireAdmin, metricsCounters } = ctx;
  // #3893 (reimplemented from @y2688): Prometheus exposition. Admin-gated —
  // request/error/latency series profile a personal brain's usage, so this
  // is not a public surface (the original PR served it unauthenticated).
  app.get('/metrics', requireAdmin, (_req: Request, res: Response) => {
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(renderPrometheusMetrics(metricsCounters));
  });
}
