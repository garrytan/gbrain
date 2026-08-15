/**
 * IngestionDaemon tests — supervision + dispatch + dedup + rate-limit.
 *
 * The daemon composes many primitives (validation, dedup, rate-limit,
 * supervision, dispatcher). These tests exercise each branch in isolation
 * by injecting fake sources, a fake dispatcher, and a fake clock.
 *
 * Engine is the throwing-proxy from test-harness (sources don't touch it
 * in these tests; if any does, fail loud).
 */

import { describe, expect, test } from 'bun:test';
import {
  IngestionDaemon,
  type DispatchOutcome,
  type IngestionDispatcher,
} from '../../src/core/ingestion/daemon.ts';
import {
  computeContentHash,
  type IngestionEvent,
  type IngestionSource,
  type IngestionSourceContext,
} from '../../src/core/ingestion/types.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { Logger } from '../../src/core/operations.ts';

// Engine proxy that throws on access. The daemon doesn't dereference it
// (only passes it through to source ctx); sources in these tests are
// minimal and don't touch it.
function makeThrowingEngine(): BrainEngine {
  return new Proxy({} as BrainEngine, {
    get(_target, prop) {
      if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.toStringTag) {
        return undefined;
      }
      throw new Error(`Engine access not allowed in test: ${String(prop)}`);
    },
  });
}

function makeCaptureLogger(): { logger: Logger; messages: Array<{ level: string; msg: string }> } {
  const messages: Array<{ level: string; msg: string }> = [];
  return {
    logger: {
      info: (msg) => messages.push({ level: 'info', msg }),
      warn: (msg) => messages.push({ level: 'warn', msg }),
      error: (msg) => messages.push({ level: 'error', msg }),
    },
    messages,
  };
}

function makeRecordingDispatcher(): {
  dispatch: IngestionDispatcher;
  recorded: IngestionEvent[];
} {
  const recorded: IngestionEvent[] = [];
  return {
    dispatch: async (event) => {
      recorded.push(event);
      return { kind: 'queued' as const, jobId: recorded.length };
    },
    recorded,
  };
}

function makeEvent(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  const content = overrides.content ?? '# default';
  return {
    source_id: 'src-1',
    source_kind: 'mock',
    source_uri: '/tmp/x.md',
    received_at: new Date('2026-05-20T12:00:00Z').toISOString(),
    content_type: 'text/markdown',
    content,
    content_hash: overrides.content_hash ?? computeContentHash(content),
    ...overrides,
  };
}

/** Build a mock source that records the ctx it receives and exposes a
 *  push() method for the test to emit events through. */
function makeControllableSource(id = 'src-1', kind = 'mock'): {
  source: IngestionSource;
  ctx: { current: IngestionSourceContext | null };
  startedAt: { current: number };
  push: (event: IngestionEvent) => void;
  stopped: { current: boolean };
} {
  const ctxRef: { current: IngestionSourceContext | null } = { current: null };
  const startedAt = { current: 0 };
  const stopped = { current: false };

  const source: IngestionSource = {
    id,
    kind,
    async start(ctx) {
      ctxRef.current = ctx;
      startedAt.current = Date.now();
    },
    async stop() {
      stopped.current = true;
    },
  };

  return {
    source,
    ctx: ctxRef,
    startedAt,
    stopped,
    push: (event) => {
      if (!ctxRef.current) throw new Error('source not started yet');
      ctxRef.current.emit(event);
    },
  };
}

async function flushMicrotasks(times = 3): Promise<void> {
  // The daemon dispatches events via Promise.resolve().then(handleEmit).
  // Yield to the microtask queue several times to ensure handleEmit + any
  // async work inside it (dispatcher promise) has settled.
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('IngestionDaemon — registration', () => {
  test('register adds a source', () => {
    const { logger } = makeCaptureLogger();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
    });
    const { source } = makeControllableSource('s1');
    daemon.register({ source });
    expect(daemon._stateForTest('s1')?.registration.source).toBe(source);
  });

  test('register rejects duplicate id', () => {
    const { logger } = makeCaptureLogger();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
    });
    daemon.register({ source: makeControllableSource('dup').source });
    expect(() =>
      daemon.register({ source: makeControllableSource('dup').source }),
    ).toThrow(/duplicate source id/);
  });

  test('register rejects after start()', async () => {
    const { logger } = makeCaptureLogger();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
    });
    daemon.register({ source: makeControllableSource('a').source });
    await daemon.start();
    expect(() =>
      daemon.register({ source: makeControllableSource('b').source }),
    ).toThrow(/after daemon has started/);
    await daemon.stop();
  });
});

describe('IngestionDaemon — lifecycle', () => {
  test('start() calls source.start with the daemon ctx', async () => {
    const { logger } = makeCaptureLogger();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
    });
    const { source, ctx } = makeControllableSource('s1');
    daemon.register({ source });
    await daemon.start();
    expect(ctx.current).not.toBeNull();
    expect(daemon.running).toBe(true);
    await daemon.stop();
  });

  test('stop() fires abort signal and calls source.stop', async () => {
    const { logger } = makeCaptureLogger();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
    });
    const { source, ctx, stopped } = makeControllableSource('s1');
    daemon.register({ source });
    await daemon.start();
    expect(ctx.current?.abortSignal.aborted).toBe(false);
    await daemon.stop();
    expect(ctx.current?.abortSignal.aborted).toBe(true);
    expect(stopped.current).toBe(true);
    expect(daemon.running).toBe(false);
  });

  test('start() throwing source enters supervisor retry loop and respects maxCrashes', async () => {
    const { logger, messages } = makeCaptureLogger();
    let starts = 0;
    const source: IngestionSource = {
      id: 'crashy',
      kind: 'mock',
      async start() {
        starts++;
        throw new Error('boom');
      },
      async stop() {},
    };
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
      supervision: { maxCrashes: 3, initialBackoffMs: 1, maxBackoffMs: 10, stableRunResetMs: 60_000 },
    });
    daemon.register({ source });
    await daemon.start();
    expect(starts).toBe(3); // crashed maxCrashes times
    const state = daemon._stateForTest('crashy');
    expect(state?.exhausted).toBe(true);
    expect(state?.lastError).toBe('boom');
    // Three warns (one per crash) + one error when exhausted.
    expect(messages.filter((m) => m.level === 'warn').length).toBeGreaterThanOrEqual(3);
    expect(messages.some((m) => m.level === 'error' && m.msg.includes('exhausted'))).toBe(true);
    await daemon.stop();
  });

  test('multiple sources start independently; one crashing doesn\'t block others', async () => {
    const { logger } = makeCaptureLogger();
    const goodSource = makeControllableSource('good', 'mock-a');
    const badSource: IngestionSource = {
      id: 'bad',
      kind: 'mock-b',
      async start() { throw new Error('bad'); },
      async stop() {},
    };
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
      supervision: { maxCrashes: 2, initialBackoffMs: 1, maxBackoffMs: 10, stableRunResetMs: 60_000 },
    });
    daemon.register({ source: goodSource.source });
    daemon.register({ source: badSource });
    await daemon.start();
    expect(goodSource.ctx.current).not.toBeNull(); // good started
    expect(daemon._stateForTest('bad')?.exhausted).toBe(true);
    expect(daemon._stateForTest('good')?.started).toBe(true);
    await daemon.stop();
  });
});

describe('IngestionDaemon — dispatch pipeline', () => {
  test('valid emit reaches dispatcher with source_id/source_kind normalized to source identity', async () => {
    const { logger } = makeCaptureLogger();
    const { dispatch, recorded } = makeRecordingDispatcher();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch,
    });
    const { source, push } = makeControllableSource('expected-id', 'expected-kind');
    daemon.register({ source });
    await daemon.start();
    // Source emits with WRONG identity fields — daemon overrides them.
    push(makeEvent({ source_id: 'WRONG', source_kind: 'WRONG' }));
    await flushMicrotasks();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.source_id).toBe('expected-id');
    expect(recorded[0]?.source_kind).toBe('expected-kind');
    await daemon.stop();
  });

  test('invalid event is dropped at validation, logged as warn', async () => {
    const { logger, messages } = makeCaptureLogger();
    const { dispatch, recorded } = makeRecordingDispatcher();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch,
    });
    const { source, push } = makeControllableSource('s', 'mock');
    daemon.register({ source });
    await daemon.start();
    push({ ...makeEvent(), content_hash: 'short' });
    await flushMicrotasks();
    expect(recorded).toHaveLength(0);
    expect(messages.some((m) => m.level === 'warn' && m.msg.includes('invalid event'))).toBe(true);
    await daemon.stop();
  });

  test('duplicate content_hash within window is silent-dedup\'d', async () => {
    const { logger } = makeCaptureLogger();
    const { dispatch, recorded } = makeRecordingDispatcher();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch,
    });
    const { source, push } = makeControllableSource('s', 'mock');
    daemon.register({ source });
    await daemon.start();
    const ev = makeEvent({ content: 'dup-content' });
    push(ev);
    push(ev);
    push(ev);
    await flushMicrotasks();
    expect(recorded).toHaveLength(1);
    const h = await daemon.healthCheck();
    expect(h.dedup.hits).toBeGreaterThanOrEqual(2);
    await daemon.stop();
  });

  test('rate limit drops events past capacity within the window', async () => {
    const { logger, messages } = makeCaptureLogger();
    const { dispatch, recorded } = makeRecordingDispatcher();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch,
      rateLimit: { capacity: 3, windowMs: 1000 },
      _now: () => 1000,
    });
    const { source, push } = makeControllableSource('s', 'mock');
    daemon.register({ source });
    await daemon.start();
    // Emit 5 unique events; only the first 3 should make it through.
    for (let i = 0; i < 5; i++) {
      push(makeEvent({ content: `unique-${i}` }));
    }
    await flushMicrotasks();
    expect(recorded).toHaveLength(3);
    expect(daemon._stateForTest('s')?.rateLimitHits).toBe(2);
    expect(messages.some((m) => m.level === 'warn' && m.msg.includes('rate limit hit'))).toBe(true);
    await daemon.stop();
  });

  test('dispatcher failure is logged but does not crash the daemon', async () => {
    const { logger, messages } = makeCaptureLogger();
    let calls = 0;
    const dispatch: IngestionDispatcher = async () => {
      calls++;
      return { kind: 'failed', error: 'queue write failed' } satisfies DispatchOutcome;
    };
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch,
    });
    const { source, push } = makeControllableSource('s', 'mock');
    daemon.register({ source });
    await daemon.start();
    push(makeEvent({ content: 'one' }));
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(messages.some((m) => m.level === 'warn' && m.msg.includes('dispatch failed'))).toBe(true);
    expect(daemon.running).toBe(true);
    await daemon.stop();
  });

  test('dispatcher throwing is caught and logged as error', async () => {
    const { logger, messages } = makeCaptureLogger();
    const dispatch: IngestionDispatcher = async () => {
      throw new Error('rogue dispatcher');
    };
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch,
    });
    const { source, push } = makeControllableSource('s', 'mock');
    daemon.register({ source });
    await daemon.start();
    push(makeEvent());
    await flushMicrotasks();
    expect(messages.some((m) => m.level === 'error' && m.msg.includes('rogue dispatcher'))).toBe(true);
    expect(daemon.running).toBe(true);
    await daemon.stop();
  });
});

describe('IngestionDaemon — health check', () => {
  test('reports ok for a clean source', async () => {
    const { logger } = makeCaptureLogger();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
    });
    daemon.register({ source: makeControllableSource('s').source });
    await daemon.start();
    const h = await daemon.healthCheck();
    expect(h.status).toBe('ok');
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]?.status).toBe('ok');
    await daemon.stop();
  });

  test('reports fail when a source exhausted maxCrashes', async () => {
    const { logger } = makeCaptureLogger();
    const crashy: IngestionSource = {
      id: 'crashy', kind: 'mock',
      async start() { throw new Error('always'); },
      async stop() {},
    };
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
      supervision: { maxCrashes: 2, initialBackoffMs: 1, maxBackoffMs: 5, stableRunResetMs: 60_000 },
    });
    daemon.register({ source: crashy });
    await daemon.start();
    const h = await daemon.healthCheck();
    expect(h.status).toBe('fail');
    expect(h.sources[0]?.status).toBe('fail');
    expect(h.sources[0]?.message).toContain('always');
    await daemon.stop();
  });

  test('forwards source healthCheck() result', async () => {
    const { logger } = makeCaptureLogger();
    const source: IngestionSource = {
      id: 's', kind: 'mock',
      async start() {},
      async stop() {},
      async healthCheck() {
        return { status: 'warn' as const, message: 'API near rate limit' };
      },
    };
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
    });
    daemon.register({ source });
    await daemon.start();
    const h = await daemon.healthCheck();
    expect(h.status).toBe('warn');
    expect(h.sources[0]?.status).toBe('warn');
    expect(h.sources[0]?.message).toBe('API near rate limit');
    await daemon.stop();
  });

  test('aggregates dedup stats', async () => {
    const { logger } = makeCaptureLogger();
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
    });
    const { source, push } = makeControllableSource('s', 'mock');
    daemon.register({ source });
    await daemon.start();
    const ev = makeEvent({ content: 'one' });
    push(ev);
    push(ev); // dedup
    await flushMicrotasks();
    const h = await daemon.healthCheck();
    expect(h.dedup.total).toBeGreaterThan(0);
    expect(h.dedup.hits).toBeGreaterThanOrEqual(1);
    await daemon.stop();
  });
});

describe('IngestionDaemon — config passthrough', () => {
  test('source receives the config registered with it', async () => {
    const { logger } = makeCaptureLogger();
    let observedConfig: Record<string, unknown> | null = null;
    const source: IngestionSource = {
      id: 's', kind: 'mock',
      async start(ctx) {
        observedConfig = ctx.config;
      },
      async stop() {},
    };
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
    });
    daemon.register({ source, config: { apiKey: 'test', threshold: 42 } });
    await daemon.start();
    expect(observedConfig).not.toBeNull();
    expect(observedConfig!).toEqual({ apiKey: 'test', threshold: 42 });
    await daemon.stop();
  });

  test('source logger is wrapped with per-source prefix', async () => {
    const { logger, messages } = makeCaptureLogger();
    const source: IngestionSource = {
      id: 'named-src', kind: 'mock',
      async start(ctx) {
        ctx.logger.info('hello from inside');
      },
      async stop() {},
    };
    const daemon = new IngestionDaemon({
      engine: makeThrowingEngine(),
      logger,
      dispatch: async () => ({ kind: 'queued' }),
    });
    daemon.register({ source });
    await daemon.start();
    expect(messages.some((m) => m.level === 'info' && m.msg === '[ingestion:named-src] hello from inside')).toBe(true);
    await daemon.stop();
  });
});
