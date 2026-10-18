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
import { cachedCapacitySnapshot, type CapacitySnapshot } from '../core/persistence/capacity-snapshot.ts';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { BrainEngine } from '../core/engine.ts';
import { resolveInflightTimeoutSeconds, resolveSessionTimeouts } from '../core/db.ts';
import { poolHealthSnapshot, type PoolHealthSnapshot } from '../core/postgres-engine/pool-stats.ts';
import { CODES } from '../core/error-registry.ts';
import { persistenceConsumerStatus } from '../core/persistence/service.ts';
import { readCheckpointBlockerMap, readTerminalFailureSummary, type TerminalSourceSummary, type TerminalSummary } from '../core/persistence/terminal-failures.ts';
import { consumerRestartRequired, selfExitSuppressed, serveTransport, type ServeTransport } from './serve-health.ts';
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

/**
 * #6650: writer terminal-failure gauges per source, from the same bounded aggregate doctor reads. Admin-gated with the
 * rest of /metrics, never on /health. A read that did not finish sets `gbrain_writer_terminal_failures_known 0` and
 * emits no per-source series, so a scraper sees unknown rather than zero.
 */
export function renderTerminalFailureMetrics(summary: TerminalSummary): string {
  const known = summary.status === 'ok';
  const lines = [
    '# HELP gbrain_writer_terminal_failures_known 1 when the terminal-failure aggregate finished within its deadline, 0 when unknown.',
    '# TYPE gbrain_writer_terminal_failures_known gauge',
    `gbrain_writer_terminal_failures_known ${known ? 1 : 0}`,
    '',
  ];
  if (!known) return lines.join('\n');
  const series: Array<[string, string, (s: TerminalSourceSummary) => number]> = [
    ['active_blockers', 'Write receipts blocking their root now (a recovery record or a sync checkpoint blocker).', s => s.active_blockers.length],
    ['unresolved', `Unresolved terminal write receipts in the last ${summary.window_days} days (not superseded, not historical, not blocking).`, s => s.unresolved.rows],
    ['historical', `Non-blocking terminal write receipts in the last ${summary.window_days} days that a later write superseded or a fixed release explains.`, s => s.historical_rows],
    ['new_24h', 'Terminal write receipts that ended in the last 24 hours.', s => s.new_last_24h],
    ['defects', 'Unresolved terminal write receipts of a gbrain defect class.', s => s.defects.reduce((n, d) => n + d.rows, 0)],
  ];
  const label = (id: string) => id.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
  for (const [name, help, value] of series) {
    lines.push(`# HELP gbrain_writer_terminal_failures_${name} ${help}`, `# TYPE gbrain_writer_terminal_failures_${name} gauge`);
    for (const source of summary.sources) lines.push(`gbrain_writer_terminal_failures_${name}{source="${label(source.source_id)}"} ${value(source)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** #6650: how long one terminal-failure aggregate serves /metrics scrapes (a 15 s scrape cadence runs the query once a minute). */
export const TERMINAL_METRICS_TTL_MS = 60_000;
const terminalSummaries = new WeakMap<BrainEngine, { at: number; summary: Promise<TerminalSummary> }>();

/**
 * The aggregate for /metrics, shared by every scrape within `TERMINAL_METRICS_TTL_MS` (in flight included). One query covers
 * every source, so the cache is the whole summary per engine; an `unknown` result is cached too, so a database that is
 * timing out is not asked again on every scrape.
 */
export function cachedTerminalSummary(engine: BrainEngine, now: number = Date.now()): Promise<TerminalSummary> {
  const hit = terminalSummaries.get(engine);
  if (hit && now - hit.at < TERMINAL_METRICS_TTL_MS) return hit.summary;
  const summary = readCheckpointBlockerMap(engine)
    .then(checkpointBlockers => readTerminalFailureSummary(engine, { checkpointBlockers }))
    .catch((error): TerminalSummary => ({ status: 'unknown', window_days: 0, reason: error instanceof Error ? error.message : String(error) }));
  terminalSummaries.set(engine, { at: now, summary });
  return summary;
}

/**
 * #6696 (A4): cumulative write-cap gauges from the 60 s capacity snapshot (never a forecast per scrape): use, cap and
 * days left per scope and resource. Alert rule: docs/guides/concurrent-writes.md#quota-near-exhaustion.
 */
export function renderCapacityMetrics(snapshot: CapacitySnapshot): string {
  if (snapshot.status !== 'ok' || !snapshot.rows.length) return '';
  const label = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
  const lines: string[] = [];
  const series: Array<[string, string, (row: CapacitySnapshot['rows'][number]) => number | null]> = [
    ['used', 'Cumulative managed-write use (request ids or reserved receipt bytes).', row => row.used],
    ['limit', 'The configured cumulative cap.', row => row.limit],
    ['days_to_exhaustion', 'Days until admission refuses at the 7-day rate (absent when the rate is zero or beyond ten years).', row => row.days_to_exhaustion],
  ];
  for (const [name, help, value] of series) {
    lines.push(`# HELP gbrain_write_capacity_${name} ${help}`, `# TYPE gbrain_write_capacity_${name} gauge`);
    for (const row of snapshot.rows) {
      const v = value(row);
      if (v !== null) lines.push(`gbrain_write_capacity_${name}{scope="${label(row.scope)}",resource="${row.resource}"} ${v}`);
    }
    lines.push('');
  }
  return lines.join('\n');
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
 * the pool's own numbers. One deep probe is in flight per engine at a time,
 * so a stuck one is never joined by a pile.
 *
 * #6543: every 503 carries a stable `code` (with `fix` and `docs` from the
 * error registry): `persistence_restart_required` when this process's
 * persistence consumer reports restart_required (read in-process before the
 * probe; it claims nothing until a restart; no request id reaches the
 * unauthenticated body), `pool_inflight_over_budget` when a statement has waited past the
 * read pool's in-flight budget, `deep_health_probe_failed` when the pooled
 * probe is still pending, timed out or failed. Both bodies carry the
 * `transport` serve read at startup (serve-health.ts). The endpoint is
 * unauthenticated, so it only reports: it never retires a connection.
 */
type DeepHealthCode = 'persistence_restart_required' | 'pool_inflight_over_budget' | 'deep_health_probe_failed';
export type DeepHealthResult =
  | { ok: true; status: 200; body: { status: 'ok'; deep: true; version: string; engine: string; probe_ms: number; pool: PoolHealthSnapshot | null; transport: ServeTransport | null } }
  | { ok: false; status: 503; body: { error: 'service_unavailable'; code: DeepHealthCode; reason?: 'pending' | 'timeout' | 'error'; error_description: string; fix: string; docs: string; self_exit_suppressed?: true; deep: true; pool: PoolHealthSnapshot | null; transport: ServeTransport | null } };

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
  consumerStatus: (engine: BrainEngine) => object = persistenceConsumerStatus,
): Promise<DeepHealthResult> {
  const pool = () => poolHealthSnapshot(engine);
  const transport = serveTransport(engine);
  const unavailable = (code: DeepHealthCode, why: string, reason?: 'pending' | 'timeout' | 'error'): DeepHealthResult => ({ ok: false, status: 503, body: {
    error: 'service_unavailable', code, ...(reason ? { reason } : {}), error_description: why, fix: CODES[code].suggestion, docs: CODES[code].docs, deep: true, pool: pool(), transport } });
  if (consumerRestartRequired(engine, consumerStatus)) {
    const result = unavailable('persistence_restart_required', 'The persistence consumer of this serve reports restart_required: it claims no write until the process restarts');
    if (result.ok || !selfExitSuppressed(engine)) return result;
    return { ...result, body: { ...result.body, self_exit_suppressed: true, fix: `self_exit_suppressed: this serve already exited on its own 3 times within the hour, so it is not exiting again; restart it by hand and investigate (gbrain sources writer status --json). ${result.body.fix}` } };
  }
  if (pendingDeepProbes.has(engine)) return unavailable('deep_health_probe_failed', 'Deep health probe still pending from an earlier request (a pooled SELECT 1 has not answered)', 'pending');
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
    return msg === 'health_timeout'
      ? unavailable('deep_health_probe_failed', `Deep health probe timed out: a pooled SELECT 1 did not answer within ${timeoutMs} ms`, 'timeout')
      : unavailable('deep_health_probe_failed', `Deep health probe failed: ${msg}`, 'error');
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  const snapshot = pool();
  // #6543 (A4): a driver with per-statement budgets reports the statements past their own budget, so a transaction that
  // declared a longer statement_timeout (or an index build that declared 0) is not called over budget; an older driver
  // falls back to the pool budget.
  const over = snapshot ? snapshot.inflight_over_budget_ms ?? (budgetMs !== null && snapshot.inflight_oldest_ms > budgetMs ? snapshot.inflight_oldest_ms : 0) : 0;
  if (over > 0) {
    return unavailable('pool_inflight_over_budget', `A pooled statement has waited ${over} ms for the server, past its in-flight budget${budgetMs !== null ? ` (the pool's is ${budgetMs} ms)` : ''}`);
  }
  return { ok: true, status: 200, body: { status: 'ok', deep: true, version, engine: engineName, probe_ms: Date.now() - started, pool: pool(), transport } };
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
  app.get('/metrics', requireAdmin, async (_req: Request, res: Response) => {
    const summary = await cachedTerminalSummary(ctx.engine);
    const capacity = await cachedCapacitySnapshot(ctx.engine);
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(renderPrometheusMetrics(metricsCounters) + renderTerminalFailureMetrics(summary) + renderCapacityMetrics(capacity));
  });
}
