/**
 * In-process watchdog for `gbrain serve --http`.
 *
 * This does not exit the process. A slow search must not flap a restart.
 * `GET /ready` returns 503 when the verdict is not ready. `GET /health`
 * stays a cheap SELECT 1 unless GBRAIN_HTTP_HEALTH_DEEP=1 and the caller
 * passes ?deep=1.
 *
 * Pipeline wedge: at least `minInflight` POST /mcp handlers have been
 * acquired (queued waiters do not count), the oldest has been running
 * longer than `pipelineMs`, and nothing has completed in that window.
 * One in-flight search never trips it.
 *
 * Heartbeat: a timer records that the event loop ran. If that timer is
 * more than 2× `heartbeatMs` late when /ready is served, the loop was
 * stalled. A fully dead loop cannot answer /ready either; that case is
 * the opt-in GBRAIN_SERVE_STALL_WATCHDOG_MS worker, which stays off.
 */

export const HTTP_WATCHDOG_DEFAULTS = {
  pipelineMs: 120_000,
  heartbeatMs: 30_000,
  minInflight: 2,
  maxInflight: 6,
  inflightWaitMs: 15_000,
} as const;

export interface HttpWatchdogConfig {
  /** No-completion window. 0 disables the pipeline check. */
  pipelineMs: number;
  /** Heartbeat interval. 0 disables the stall check. */
  heartbeatMs: number;
  /** Pipeline check requires at least this many acquired MCP requests. */
  minInflight: number;
  /** Concurrent POST /mcp handler slots. 0 disables the gate. */
  maxInflight: number;
  /** How long a request waits for a slot before HTTP 503. */
  inflightWaitMs: number;
  /** When true, GET /health?deep=1 consults this watchdog. */
  deepHealth: boolean;
  /** When false, GBRAIN_HTTP_FATAL_EXIT=0 and the process stays up. */
  fatalExit: boolean;
}

export type WatchdogReason = 'event_loop_stalled' | 'pipeline_wedged';

export interface WatchdogVerdict {
  ready: boolean;
  reason: WatchdogReason | null;
}

type Warn = (msg: string) => void;

function parseNonNegative(name: string, raw: string | undefined, fallback: number, warn: Warn): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    warn(`[serve-http] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

export function resolveHttpWatchdogConfig(
  env: Record<string, string | undefined> = process.env,
  warn: Warn = (msg) => { console.error(msg); },
): HttpWatchdogConfig {
  const pipelineMs = parseNonNegative('GBRAIN_HTTP_WATCHDOG_MS', env.GBRAIN_HTTP_WATCHDOG_MS, HTTP_WATCHDOG_DEFAULTS.pipelineMs, warn);
  const heartbeatMs = parseNonNegative('GBRAIN_HTTP_WATCHDOG_HEARTBEAT_MS', env.GBRAIN_HTTP_WATCHDOG_HEARTBEAT_MS, HTTP_WATCHDOG_DEFAULTS.heartbeatMs, warn);
  let minInflight = parseNonNegative('GBRAIN_HTTP_WATCHDOG_MIN_INFLIGHT', env.GBRAIN_HTTP_WATCHDOG_MIN_INFLIGHT, HTTP_WATCHDOG_DEFAULTS.minInflight, warn);
  if (env.GBRAIN_HTTP_WATCHDOG_MIN_INFLIGHT !== undefined && env.GBRAIN_HTTP_WATCHDOG_MIN_INFLIGHT.trim() !== '' && minInflight < 1) {
    warn(`[serve-http] GBRAIN_HTTP_WATCHDOG_MIN_INFLIGHT must be >= 1; using ${HTTP_WATCHDOG_DEFAULTS.minInflight}`);
    minInflight = HTTP_WATCHDOG_DEFAULTS.minInflight;
  }
  const maxInflight = parseNonNegative('GBRAIN_HTTP_MAX_INFLIGHT', env.GBRAIN_HTTP_MAX_INFLIGHT, HTTP_WATCHDOG_DEFAULTS.maxInflight, warn);
  const inflightWaitMs = parseNonNegative('GBRAIN_HTTP_INFLIGHT_WAIT_MS', env.GBRAIN_HTTP_INFLIGHT_WAIT_MS, HTTP_WATCHDOG_DEFAULTS.inflightWaitMs, warn);
  const deepRaw = env.GBRAIN_HTTP_HEALTH_DEEP;
  const deepHealth = deepRaw === '1' || deepRaw === 'true';
  const fatalExit = env.GBRAIN_HTTP_FATAL_EXIT !== '0';
  return { pipelineMs, heartbeatMs, minInflight, maxInflight, inflightWaitMs, deepHealth, fatalExit };
}

export function readinessHttpResult(
  verdict: WatchdogVerdict,
  version: string,
  engineName: string,
): { status: number; body: Record<string, unknown> } {
  if (verdict.ready) {
    return { status: 200, body: { status: 'ready', version, engine: engineName } };
  }
  return {
    status: 503,
    body: { status: 'not_ready', reason: verdict.reason, version, engine: engineName },
  };
}

export class HttpPipelineWatchdog {
  private readonly inflight: Array<{ id: number; startedAt: number }> = [];
  private nextId = 1;
  private lastCompletionAt: number;
  private lastHeartbeatAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatArmed = false;

  constructor(
    private readonly cfg: HttpWatchdogConfig,
    private readonly now: () => number = Date.now,
  ) {
    const t = now();
    this.lastCompletionAt = t;
    this.lastHeartbeatAt = t;
  }

  start(): void {
    if (this.timer || this.cfg.heartbeatMs <= 0) return;
    this.heartbeatArmed = true;
    const interval = Math.max(250, Math.floor(this.cfg.heartbeatMs / 2));
    this.timer = setInterval(() => { this.lastHeartbeatAt = this.now(); }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.heartbeatArmed = false;
  }

  /** Call only after the inflight gate is acquired. The returned function is idempotent. */
  begin(): () => void {
    const id = this.nextId++;
    this.inflight.push({ id, startedAt: this.now() });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const idx = this.inflight.findIndex(row => row.id === id);
      if (idx >= 0) this.inflight.splice(idx, 1);
      this.lastCompletionAt = this.now();
    };
  }

  assess(now: number = this.now()): WatchdogVerdict {
    if (this.heartbeatArmed && this.cfg.heartbeatMs > 0 && now - this.lastHeartbeatAt > this.cfg.heartbeatMs * 2) {
      return { ready: false, reason: 'event_loop_stalled' };
    }
    if (this.cfg.pipelineMs > 0 && this.inflight.length >= this.cfg.minInflight) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const row of this.inflight) if (row.startedAt < oldest) oldest = row.startedAt;
      const noCompletion = now - this.lastCompletionAt >= this.cfg.pipelineMs;
      const oldestStale = now - oldest >= this.cfg.pipelineMs;
      if (noCompletion && oldestStale) return { ready: false, reason: 'pipeline_wedged' };
    }
    return { ready: true, reason: null };
  }
}

interface Waiter {
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  grant: (release: () => void) => void;
}

/**
 * Soft cap on concurrent POST /mcp handler bodies. Waiters that time out
 * get `{ ok: false }` so the route can return HTTP 503 instead of queueing
 * forever. `max <= 0` disables the gate.
 */
export class HttpInflightGate {
  private held = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly max: number, private readonly waitMs: number) {}

  async acquire(): Promise<{ ok: true; release: () => void } | { ok: false }> {
    if (this.max <= 0) return { ok: true, release: () => {} };
    if (this.held < this.max) {
      this.held++;
      return this.holdRelease();
    }
    return new Promise(resolve => {
      const entry: Waiter = {
        settled: false,
        timer: setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve({ ok: false });
        }, this.waitMs),
        grant: (release) => {
          if (entry.settled) return;
          entry.settled = true;
          clearTimeout(entry.timer);
          resolve({ ok: true, release });
        },
      };
      entry.timer.unref?.();
      this.waiters.push(entry);
    });
  }

  private holdRelease(): { ok: true; release: () => void } {
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.releaseOne();
      },
    };
  }

  private releaseOne(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (next.settled) continue;
      next.grant(() => this.releaseOne());
      return;
    }
    this.held = Math.max(0, this.held - 1);
  }
}
