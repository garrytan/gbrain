/**
 * IngestionTestHarness — Publisher-facing test utility for IngestionSource authors.
 *
 * Exported as a public subpath (gbrain/ingestion/test-harness) and pinned by
 * test/public-exports.test.ts so it stays a versioned API for skillpack
 * publishers. Treat as the equivalent of @testing-library for browser apps:
 * downstream code depends on this surface, breaking it requires a major bump.
 *
 * Typical usage:
 *
 *   import { IngestionTestHarness, expectEvent } from 'gbrain/ingestion/test-harness';
 *   import { GranolaSource } from './source';
 *
 *   test('emits one event per transcript', async () => {
 *     const harness = new IngestionTestHarness({ config: { apiKey: 'fake' } });
 *     const source = new GranolaSource();
 *     await harness.run(source);
 *     await harness.advance(60_000); // fake clock advance
 *     expect(harness.events).toHaveLength(1);
 *     expectEvent(harness.events[0]).toHaveKind('voice-whisper');
 *     expectEvent(harness.events[0]).toHaveContentHash();
 *     await harness.stop();
 *   });
 *
 * The harness deliberately does NOT spin up a PGLite brain — that's what
 * `gbrain ingest test --watch` is for (CLI-side ephemeral brain for the
 * full daemon-roundtrip iteration loop). The harness is for fast unit
 * tests against the source contract in isolation.
 */

import type {
  IngestionEvent,
  IngestionSource,
  IngestionSourceContext,
  IngestionSourceHealth,
} from './types.ts';
import { validateIngestionEvent } from './types.ts';
import type { BrainEngine } from '../engine.ts';
import type { Logger } from '../operations.ts';

export interface IngestionTestHarnessOpts {
  /** Source-specific config passed to source.start(ctx). Defaults to {}. */
  config?: Record<string, unknown>;
  /** Bring-your-own engine. When omitted, ctx.engine is a Proxy that throws
   *  on any property access — sources that touch the engine fail loud in
   *  tests, prompting the publisher to either pass a real engine here or
   *  refactor the source to not depend on it. */
  engine?: BrainEngine;
  /** Custom logger. Defaults to capturing logs into harness.logs. */
  logger?: Logger;
  /** Initial fake clock value (ms since epoch). Defaults to a fixed
   *  deterministic point in 2026 so tests don't flake on real clock drift. */
  startTime?: number;
}

/**
 * Single-source test harness. Construct one per test; not designed to host
 * multiple sources simultaneously (that's the daemon's job; tests should
 * exercise sources in isolation).
 */
export class IngestionTestHarness {
  private readonly opts: IngestionTestHarnessOpts;
  private readonly _events: IngestionEvent[] = [];
  private readonly _logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string }> = [];
  private readonly _validationErrors: string[] = [];
  private readonly _abortController = new AbortController();
  private _currentTime: number;
  private _activeSource: IngestionSource | null = null;
  private _running = false;

  constructor(opts: IngestionTestHarnessOpts = {}) {
    this.opts = opts;
    // Deterministic default: 2026-05-20T12:00:00Z — chosen far enough into
    // the future that any historical date tests of the source (e.g. a
    // file-watcher checking mtime) don't get confused by Date.now() drift.
    this._currentTime = opts.startTime ?? 1747742400000;
  }

  /** Recorded events from the source so far, in emit order. */
  get events(): readonly IngestionEvent[] {
    return this._events;
  }

  /** Recorded log calls from the source. */
  get logs(): readonly { level: 'info' | 'warn' | 'error'; msg: string }[] {
    return this._logs;
  }

  /** Validation errors observed at the harness boundary. Real daemon
   *  rejects malformed events; harness collects them so tests can
   *  assert "my source never emits a bad event". */
  get validationErrors(): readonly string[] {
    return this._validationErrors;
  }

  /** Whether the source is currently in its `start`/`emit` lifecycle. */
  get running(): boolean {
    return this._running;
  }

  /** Build the context the daemon would pass to the source. */
  private buildContext(): IngestionSourceContext {
    const harness = this;
    return {
      emit(event: IngestionEvent): void {
        const err = validateIngestionEvent(event);
        if (err) {
          harness._validationErrors.push(`${err.field}: ${err.reason}`);
          return;
        }
        harness._events.push(event);
      },
      engine: this.opts.engine ?? createThrowingEngineProxy(),
      logger: this.opts.logger ?? this.buildCaptureLogger(),
      abortSignal: this._abortController.signal,
      config: this.opts.config ?? {},
    };
  }

  private buildCaptureLogger(): Logger {
    const logs = this._logs;
    return {
      info(msg: string) { logs.push({ level: 'info', msg }); },
      warn(msg: string) { logs.push({ level: 'warn', msg }); },
      error(msg: string) { logs.push({ level: 'error', msg }); },
    };
  }

  /**
   * Run the source's start lifecycle. Returns once `source.start(ctx)`
   * resolves — note that for sources that watch indefinitely (file
   * watcher, scheduler), `start` typically resolves quickly with the
   * source running in the background. The harness keeps the abort
   * signal alive until `stop()` is called.
   */
  async run(source: IngestionSource): Promise<void> {
    if (this._running) {
      throw new Error('IngestionTestHarness already running a source; construct a new harness per test');
    }
    this._activeSource = source;
    this._running = true;
    const ctx = this.buildContext();
    await source.start(ctx);
  }

  /**
   * Advance the harness clock by `ms` milliseconds. Sources that schedule
   * timers via the standard setTimeout will fire if the test suite is also
   * using Bun's fake timers; this helper just bumps the harness's own clock
   * reading so log timestamps and dedup windows reflect the test's time.
   *
   * Note: this does NOT advance global setTimeout — use `Bun.sleep(ms)` or
   * `await new Promise(r => setTimeout(r, 0))` in test code if you need to
   * yield to source's pending microtasks.
   */
  advance(ms: number): void {
    if (ms < 0) {
      throw new Error('IngestionTestHarness.advance(ms): ms must be >= 0');
    }
    this._currentTime += ms;
  }

  /** Current fake clock value. Sources can read via ctx.config or the
   *  harness can be queried by tests asserting on time. */
  now(): number {
    return this._currentTime;
  }

  /**
   * Call source.healthCheck() if defined and return the result. Sources
   * without a healthCheck implementation surface as `ok`.
   */
  async healthCheck(): Promise<IngestionSourceHealth> {
    if (!this._activeSource) {
      throw new Error('IngestionTestHarness.healthCheck(): no source started');
    }
    if (this._activeSource.healthCheck) {
      return this._activeSource.healthCheck();
    }
    return { status: 'ok' };
  }

  /**
   * Stop the active source. Fires the abort signal, then calls source.stop().
   * Source MUST cooperate within a bounded grace window (default 5 seconds).
   */
  async stop(graceMs = 5000): Promise<void> {
    if (!this._running || !this._activeSource) return;
    this._abortController.abort();
    const stopPromise = this._activeSource.stop();
    const timeoutPromise = new Promise<void>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`IngestionTestHarness.stop(): source did not stop within ${graceMs}ms`)),
        graceMs,
      );
      // Clear the timeout if stop resolves first so the test process doesn't
      // hang on a pending timer.
      stopPromise.finally(() => clearTimeout(t)).catch(() => {});
    });
    try {
      await Promise.race([stopPromise, timeoutPromise]);
    } finally {
      this._running = false;
      this._activeSource = null;
    }
  }

  /** Clear recorded events + logs without resetting the clock or running
   *  state. Useful between phases of a multi-step test. */
  clearRecorded(): void {
    this._events.length = 0;
    this._logs.length = 0;
    this._validationErrors.length = 0;
  }
}

/**
 * Fluent expectation helper. Pairs with bun:test / Vitest / Jest expect()
 * without depending on any of them — pure value checks that throw on
 * mismatch.
 *
 *   expectEvent(events[0]).toHaveKind('voice-whisper');
 *   expectEvent(events[0]).toHaveContentHash();
 *   expectEvent(events[0]).toHaveSourceUri(matching: /\.granola$/);
 */
export function expectEvent(event: IngestionEvent | undefined) {
  function fail(msg: string): never {
    const got = event === undefined ? 'undefined' : JSON.stringify(event, null, 2);
    throw new Error(`expectEvent: ${msg}\nGot: ${got}`);
  }

  return {
    toExist(): IngestionEvent {
      if (event === undefined) fail('event was undefined');
      return event as IngestionEvent;
    },
    toHaveKind(kind: string): void {
      if (!event) fail(`expected kind '${kind}' but event was undefined`);
      if (event.source_kind !== kind) {
        fail(`expected source_kind '${kind}', got '${event.source_kind}'`);
      }
    },
    toHaveSourceId(id: string): void {
      if (!event) fail(`expected source_id '${id}' but event was undefined`);
      if (event.source_id !== id) {
        fail(`expected source_id '${id}', got '${event.source_id}'`);
      }
    },
    toHaveSourceUri(matching: string | RegExp): void {
      if (!event) fail('event was undefined');
      const uri = event.source_uri;
      if (matching instanceof RegExp) {
        if (!matching.test(uri)) fail(`source_uri '${uri}' did not match ${matching}`);
      } else if (uri !== matching) {
        fail(`expected source_uri '${matching}', got '${uri}'`);
      }
    },
    toHaveContentType(type: string): void {
      if (!event) fail(`expected content_type '${type}' but event was undefined`);
      if (event.content_type !== type) {
        fail(`expected content_type '${type}', got '${event.content_type}'`);
      }
    },
    toHaveContentHash(hash?: string): void {
      if (!event) fail('event was undefined');
      if (!/^[0-9a-f]{64}$/i.test(event.content_hash)) {
        fail(`content_hash '${event.content_hash}' is not a valid SHA-256 hex string`);
      }
      if (hash !== undefined && event.content_hash !== hash) {
        fail(`expected content_hash '${hash}', got '${event.content_hash}'`);
      }
    },
    toBeUntrusted(): void {
      if (!event) fail('event was undefined');
      if (event.untrusted_payload !== true) {
        fail(`expected untrusted_payload: true, got ${event.untrusted_payload}`);
      }
    },
    toBeTrusted(): void {
      if (!event) fail('event was undefined');
      if (event.untrusted_payload === true) {
        fail('expected event to be trusted, but untrusted_payload was true');
      }
    },
    toHaveMetadata(matcher: Record<string, unknown>): void {
      if (!event) fail('event was undefined');
      const md = event.metadata ?? {};
      for (const [k, v] of Object.entries(matcher)) {
        if ((md as Record<string, unknown>)[k] !== v) {
          fail(`expected metadata.${k}=${JSON.stringify(v)}, got ${JSON.stringify((md as Record<string, unknown>)[k])}`);
        }
      }
    },
  };
}

/**
 * Construct a BrainEngine proxy that throws on every property access. Used
 * as the default ctx.engine in the harness so sources that touch the engine
 * fail loudly in tests with a paste-ready hint to provide a real engine.
 *
 * Returning a no-op stub instead would let bugs through — a source that
 * silently swallows engine calls in tests would pass and then crash in
 * production.
 */
function createThrowingEngineProxy(): BrainEngine {
  return new Proxy({} as BrainEngine, {
    get(_target, prop) {
      // Some runtime probes happen during Promise unwrapping etc. — let
      // these pass without throwing so the harness doesn't blow up on
      // type introspection. The named methods are what trigger the error.
      if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.toStringTag) {
        return undefined;
      }
      throw new Error(
        `IngestionTestHarness: source attempted to access BrainEngine.${String(prop)} ` +
        `but no engine was provided. Pass { engine } to new IngestionTestHarness({...}) ` +
        `with a real engine (e.g. new PGLiteEngine()) if the source needs DB access, ` +
        `OR refactor the source so it doesn't touch the engine and only emits events.`,
      );
    },
  });
}
