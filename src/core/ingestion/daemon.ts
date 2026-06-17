/**
 * IngestionDaemon — supervises N pluggable IngestionSource instances,
 * dispatches their events into the Minion queue.
 *
 * Composition:
 *   - per-source supervision via SourceSupervisor (sibling pattern to the
 *     v0.34.3.0 ChildWorkerSupervisor, but for in-process modules instead
 *     of subprocesses)
 *   - daemon-side validation (validateIngestionEvent at the boundary)
 *   - 24h content-hash dedup (DedupWindow)
 *   - per-source rate limit (token bucket, default 100 events / 10s)
 *   - pluggable event dispatch (constructor-injected). Production wires
 *     this to MinionQueue.add('ingest_capture', ...). Tests inject a
 *     recorder so the daemon can be exercised in isolation.
 *
 * Scope notes:
 *   - The webhook source does NOT live here. It lives in `serve --http`
 *     (E1 eng-review decision) and submits ingest_capture Minion jobs
 *     directly via the existing OAuth-gated route. The daemon supervises
 *     only daemon-side sources: file-watcher, inbox-folder, cron-scheduler,
 *     and skillpack-distributed sources.
 *
 *   - Content-type processors (PDF, OCR, audio transcribe, video keyframe)
 *     are wired through the daemon dispatcher in a later commit. The
 *     contract here is "daemon emits ingest_capture with the IngestionEvent
 *     payload"; the processor router decides inline-vs-Minion handler
 *     based on byte size before the event leaves the daemon.
 *
 *   - Daemon process model: subsumes the v0.37 autopilot daemon. A separate
 *     commit handles the launchd plist rename and backward-compat alias.
 *
 * Error model:
 *   - Source.start() throws → SourceSupervisor catches, increments crash
 *     counter, applies exponential backoff, restarts up to maxCrashes.
 *   - Source emits invalid event → daemon logs and drops; source keeps
 *     running. Bug surfaces in `gbrain doctor ingestion_health`.
 *   - Dispatcher throws → daemon logs but does NOT crash the source. The
 *     queue write failed (DB blip, etc.); subsequent emits will retry.
 *   - Rate-limit exceeded → daemon drops the event silently. Source
 *     enters `warn` health when sustained backpressure exceeds threshold.
 */

import type {
  IngestionEvent,
  IngestionSource,
  IngestionSourceContext,
  IngestionSourceHealth,
} from './types.ts';
import { validateIngestionEvent } from './types.ts';
import { DedupWindow } from './dedup.ts';
import type { Logger } from '../operations.ts';
import type { BrainEngine } from '../engine.ts';

interface RateLimitConfig {
  /** Events allowed per window. */
  capacity: number;
  /** Window length in ms. */
  windowMs: number;
}

interface SupervisionConfig {
  /** Max consecutive crashes before the source is marked `fail`. */
  maxCrashes: number;
  /** Stable run window: a crash after this duration resets crashCount to 1. */
  stableRunResetMs: number;
  /** Initial backoff in ms. Doubles on each crash up to ceiling. */
  initialBackoffMs: number;
  /** Backoff ceiling. */
  maxBackoffMs: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  capacity: 100,
  windowMs: 10_000,
};

const DEFAULT_SUPERVISION: SupervisionConfig = {
  maxCrashes: 10,
  stableRunResetMs: 5 * 60_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

/** Outcome the dispatcher returns. Lets the daemon distinguish queue
 *  retryable failures from genuine drops (e.g. invalid payload). */
export type DispatchOutcome =
  | { kind: 'queued'; jobId?: number }
  | { kind: 'failed'; error: string };

export type IngestionDispatcher = (
  event: IngestionEvent,
) => Promise<DispatchOutcome>;

export interface IngestionDaemonOpts {
  /** Engine handle exposed to sources via ctx.engine. Sources should only
   *  read; the daemon routes writes via the dispatcher. */
  engine: BrainEngine;
  /** Daemon-wide logger. Source-specific log lines route through a per-source
   *  wrapper so messages carry the source id. */
  logger: Logger;
  /** Where events go after validation + dedup + rate-limit. Production
   *  wires this to MinionQueue.add('ingest_capture', ...). */
  dispatch: IngestionDispatcher;
  /** Per-source rate limit override. */
  rateLimit?: Partial<RateLimitConfig>;
  /** Per-source supervision override. */
  supervision?: Partial<SupervisionConfig>;
  /** Test seam: alternative clock. */
  _now?: () => number;
}

export interface SourceRegistration {
  source: IngestionSource;
  /** Source-specific config. Merged with the source's declared
   *  default_config (if from a skillpack) at registration time. */
  config?: Record<string, unknown>;
}

export interface DaemonHealth {
  /** Overall daemon status: `ok` if every source is `ok`, `warn` if any
   *  source is `warn` (but daemon is still functional), `fail` if any
   *  source has exceeded maxCrashes and is offline. */
  status: 'ok' | 'warn' | 'fail';
  /** Per-source breakdown. */
  sources: Array<{
    id: string;
    kind: string;
    status: 'ok' | 'warn' | 'fail';
    message?: string;
    crashCount: number;
    eventCount: number;
    rateLimitHits: number;
  }>;
  /** Dedup stats since daemon start. */
  dedup: {
    total: number;
    hits: number;
    evictions: number;
    size: number;
  };
}

/** Per-source supervision state. Internal to the daemon. */
interface SourceState {
  registration: SourceRegistration;
  abortController: AbortController;
  crashCount: number;
  lastStartTime: number;
  /** Rolling event-timestamp buffer for the token-bucket rate limiter. */
  rateLimitTimestamps: number[];
  /** Total events emitted since daemon start (post-dedup, pre-dispatch). */
  eventCount: number;
  /** Rate-limit drops since daemon start. */
  rateLimitHits: number;
  /** Marked once start() resolves successfully — used by health to
   *  distinguish "still starting" from "running". */
  started: boolean;
  /** Set when the source has exceeded maxCrashes; daemon stops trying. */
  exhausted: boolean;
  /** Last error message from start() / supervisor — for the health surface. */
  lastError: string | null;
}

export class IngestionDaemon {
  private readonly opts: IngestionDaemonOpts;
  private readonly dedup: DedupWindow;
  private readonly sources: Map<string, SourceState> = new Map();
  private readonly supervision: SupervisionConfig;
  private readonly rateLimit: RateLimitConfig;
  private _running = false;
  private _stopping = false;

  constructor(opts: IngestionDaemonOpts) {
    this.opts = opts;
    this.dedup = new DedupWindow({ _now: opts._now });
    this.supervision = { ...DEFAULT_SUPERVISION, ...(opts.supervision ?? {}) };
    this.rateLimit = { ...DEFAULT_RATE_LIMIT, ...(opts.rateLimit ?? {}) };
  }

  /** Whether the daemon is currently in its start/run lifecycle. */
  get running(): boolean {
    return this._running;
  }

  /**
   * Register a source. Throws on duplicate id — the daemon's identity
   * model requires unique source instance ids.
   */
  register(registration: SourceRegistration): void {
    if (this._running) {
      throw new Error(
        `IngestionDaemon.register: cannot register source '${registration.source.id}' ` +
          `after daemon has started; call register before start()`,
      );
    }
    const id = registration.source.id;
    if (this.sources.has(id)) {
      throw new Error(`IngestionDaemon.register: duplicate source id '${id}'`);
    }
    this.sources.set(id, {
      registration,
      abortController: new AbortController(),
      crashCount: 0,
      lastStartTime: 0,
      rateLimitTimestamps: [],
      eventCount: 0,
      rateLimitHits: 0,
      started: false,
      exhausted: false,
      lastError: null,
    });
  }

  /**
   * Start every registered source. Each source's lifecycle runs
   * independently — a crash in one does not stop others. Resolves when
   * all sources have either started successfully OR exhausted maxCrashes.
   */
  async start(): Promise<void> {
    if (this._running) {
      throw new Error('IngestionDaemon.start: already running');
    }
    this._running = true;
    this._stopping = false;

    // Fire each source's supervisor in parallel. Each returns when the
    // source is either running or exhausted.
    const startPromises = Array.from(this.sources.keys()).map((id) =>
      this.superviseSource(id),
    );

    // The supervisor returns once start() resolves (source is "running")
    // OR once maxCrashes is hit. We wait for the initial start round to
    // complete so the caller knows daemon-startup is done.
    await Promise.all(startPromises);
  }

  /**
   * Stop every source. Fires abort signals, calls source.stop(), waits up
   * to `graceMs` for each to drain. Force-marks any source that overruns.
   */
  async stop(graceMs = 5000): Promise<void> {
    if (!this._running) return;
    this._stopping = true;

    const stopPromises: Promise<void>[] = [];
    for (const [id, state] of this.sources) {
      state.abortController.abort();
      if (!state.started) continue;
      const p = (async () => {
        try {
          await raceWithTimeout(
            state.registration.source.stop(),
            graceMs,
            `source '${id}' did not stop within ${graceMs}ms`,
          );
        } catch (err) {
          this.opts.logger.warn(
            `[ingestion] source '${id}' stop failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
      stopPromises.push(p);
    }

    await Promise.all(stopPromises);
    this._running = false;
    this._stopping = false;
  }

  /** Aggregate health report for `gbrain doctor ingestion_health`. */
  async healthCheck(): Promise<DaemonHealth> {
    const perSource: DaemonHealth['sources'] = [];
    let aggregateStatus: 'ok' | 'warn' | 'fail' = 'ok';

    for (const [id, state] of this.sources) {
      let status: 'ok' | 'warn' | 'fail';
      let message: string | undefined;

      if (state.exhausted) {
        status = 'fail';
        message = state.lastError ?? 'source exceeded maxCrashes';
      } else if (state.crashCount > 0) {
        status = 'warn';
        message = `${state.crashCount} crash(es) since last stable run${state.lastError ? `: ${state.lastError}` : ''}`;
      } else if (state.started && state.registration.source.healthCheck) {
        try {
          const result = await raceWithTimeout(
            state.registration.source.healthCheck(),
            5_000,
            `source '${id}' healthCheck() timed out`,
          );
          status = result.status;
          message = result.message;
        } catch (err) {
          status = 'warn';
          message = err instanceof Error ? err.message : String(err);
        }
      } else {
        status = state.started ? 'ok' : 'warn';
        if (!state.started) message = 'not started yet';
      }

      perSource.push({
        id,
        kind: state.registration.source.kind,
        status,
        message,
        crashCount: state.crashCount,
        eventCount: state.eventCount,
        rateLimitHits: state.rateLimitHits,
      });

      // Worst-case wins.
      if (status === 'fail' || (status === 'warn' && aggregateStatus === 'ok')) {
        aggregateStatus = status;
      }
    }

    return {
      status: aggregateStatus,
      sources: perSource,
      dedup: this.dedup.stats(),
    };
  }

  /**
   * Per-source supervision loop. Mirrors the ChildWorkerSupervisor pattern
   * (crash counter + stable-run reset + exponential backoff + max crashes)
   * adapted for in-process JS modules.
   */
  private async superviseSource(id: string): Promise<void> {
    const state = this.sources.get(id);
    if (!state) return;
    const source = state.registration.source;

    while (!this._stopping && state.crashCount < this.supervision.maxCrashes) {
      state.lastStartTime = this.now();
      state.abortController = new AbortController();

      const ctx = this.buildContext(state);

      try {
        await source.start(ctx);
        state.started = true;
        state.lastError = null;
        // Success — exit the supervisor loop. The source is now running
        // in the background, emitting events via ctx.emit. The daemon
        // does NOT call start() repeatedly; only on crash.
        return;
      } catch (err) {
        state.started = false;
        const errMsg = err instanceof Error ? err.message : String(err);
        state.lastError = errMsg;
        const runDuration = this.now() - state.lastStartTime;

        if (runDuration > this.supervision.stableRunResetMs) {
          state.crashCount = 1; // stable-run reset
        } else {
          state.crashCount++;
        }

        this.opts.logger.warn(
          `[ingestion] source '${id}' start failed (crash ${state.crashCount}/${this.supervision.maxCrashes}): ${errMsg}`,
        );

        if (state.crashCount >= this.supervision.maxCrashes) {
          state.exhausted = true;
          this.opts.logger.error(
            `[ingestion] source '${id}' exhausted maxCrashes=${this.supervision.maxCrashes}; ` +
              `giving up. Last error: ${errMsg}`,
          );
          return;
        }

        // Exponential backoff: 1s, 2s, 4s, ... capped at maxBackoffMs.
        const backoff = Math.min(
          this.supervision.initialBackoffMs * 2 ** (state.crashCount - 1),
          this.supervision.maxBackoffMs,
        );
        await this.sleep(backoff);
      }
    }
  }

  /**
   * Build the IngestionSourceContext for a given source. Each emit goes
   * through the daemon's validate → dedup → rate-limit → dispatch pipeline.
   */
  private buildContext(state: SourceState): IngestionSourceContext {
    const daemon = this;
    const sourceId = state.registration.source.id;
    return {
      emit(event: IngestionEvent): void {
        // Schedule via microtask so the source's emit() returns synchronously
        // (publishers expect emit to be fire-and-forget). Errors in the
        // pipeline log but don't propagate back to the source.
        Promise.resolve().then(() => daemon.handleEmit(state, event)).catch((err) => {
          daemon.opts.logger.error(
            `[ingestion] source '${sourceId}' dispatch error: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
      engine: daemon.opts.engine,
      logger: daemon.wrapLogger(sourceId),
      abortSignal: state.abortController.signal,
      config: state.registration.config ?? {},
    };
  }

  /**
   * Process a single emit through the daemon pipeline:
   *   1. Validate event shape — drop on failure.
   *   2. Check dedup window — drop on hit.
   *   3. Check rate limit — drop on bucket exhausted.
   *   4. Dispatch to Minion queue via opts.dispatch.
   */
  private async handleEmit(state: SourceState, event: IngestionEvent): Promise<void> {
    const sourceId = state.registration.source.id;
    const sourceKind = state.registration.source.kind;

    // 1. Validate.
    const validationErr = validateIngestionEvent(event);
    if (validationErr) {
      this.opts.logger.warn(
        `[ingestion] source '${sourceId}' emitted invalid event: ${validationErr.message}`,
      );
      return;
    }

    // Defense in depth: validated event but kind mismatch means the source
    // is lying about its identity. Trust source.kind over event.source_kind.
    const effectiveEvent: IngestionEvent = { ...event, source_kind: sourceKind, source_id: sourceId };

    // 2. Dedup — TRICKLE MODE ONLY (v0.41 T2). Migration-mode sources own
    // their own permanent slug-keyed idempotency (via op_checkpoint); the
    // 24h DedupWindow is wrong for bulk historical replay where retries
    // happen days apart and content_hash collisions across the import
    // window are expected. Default-undefined source.mode treats as
    // 'trickle' for v0.38 back-compat.
    const sourceMode = state.registration.source.mode ?? 'trickle';
    if (sourceMode === 'trickle') {
      const isNew = this.dedup.mark(sourceKind, effectiveEvent.content_hash);
      if (!isNew) {
        // Silent dedup hit. dedup.hits counter already incremented.
        return;
      }
    }
    // Migration mode: skip the dedup window entirely. The source's own
    // idempotency layer is the authoritative duplicate gate; reaching here
    // means the source already decided this event should land.

    // 3. Rate limit (token-bucket-ish: count events in trailing window).
    const nowMs = this.now();
    const windowStart = nowMs - this.rateLimit.windowMs;
    state.rateLimitTimestamps = state.rateLimitTimestamps.filter((t) => t > windowStart);
    if (state.rateLimitTimestamps.length >= this.rateLimit.capacity) {
      state.rateLimitHits++;
      this.opts.logger.warn(
        `[ingestion] source '${sourceId}' rate limit hit ` +
          `(${this.rateLimit.capacity} events / ${this.rateLimit.windowMs}ms); dropping event`,
      );
      return;
    }
    state.rateLimitTimestamps.push(nowMs);
    state.eventCount++;

    // 4. Dispatch.
    try {
      const outcome = await this.opts.dispatch(effectiveEvent);
      if (outcome.kind === 'failed') {
        this.opts.logger.warn(
          `[ingestion] source '${sourceId}' dispatch failed: ${outcome.error}`,
        );
      }
    } catch (err) {
      this.opts.logger.error(
        `[ingestion] source '${sourceId}' dispatcher threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Wrap the daemon logger with a per-source prefix. */
  private wrapLogger(sourceId: string): Logger {
    const baseLogger = this.opts.logger;
    return {
      info(msg: string) { baseLogger.info(`[ingestion:${sourceId}] ${msg}`); },
      warn(msg: string) { baseLogger.warn(`[ingestion:${sourceId}] ${msg}`); },
      error(msg: string) { baseLogger.error(`[ingestion:${sourceId}] ${msg}`); },
    };
  }

  private now(): number {
    return this.opts._now ? this.opts._now() : Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Internal access for tests. @internal */
  _stateForTest(id: string): Readonly<SourceState> | undefined {
    return this.sources.get(id);
  }
}

/**
 * Race a promise against a timeout. Rejects with the timeout message if
 * the promise hasn't settled in `ms`. Caller is responsible for cleanup
 * — used by stop() drains and healthCheck() probes.
 */
function raceWithTimeout<T>(p: Promise<T>, ms: number, timeoutMsg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMsg));
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        reject(err);
      },
    );
  });
}
