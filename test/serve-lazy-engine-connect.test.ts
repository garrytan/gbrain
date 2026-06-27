import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'events';
import { runServe, type ServeOptions } from '../src/commands/serve';
import {
  createEngineProvider,
  isEngineProvider,
  type EngineProvider,
} from '../src/core/engine-provider';
import type { BrainEngine } from '../src/core/engine';

// #2091: the stdio serve path must answer the MCP initialize handshake
// before the engine (PGLite WASM boot + write-lock acquire) is ready —
// MCP hosts enforce a connect timeout (Claude Code: 30s) and kill the
// server otherwise. These tests pin the three behaviors that fix carries:
//
//   1. runServe with a lazy connector reaches startMcpServer while the
//      connect is still in flight (handshake never waits on the boot).
//   2. A shutdown that races the in-flight connect still releases the
//      engine — the observed-in-production leak was disconnect() running
//      before the lock was acquired, then the connect completing and
//      leaking the lock dir.
//   3. A failed connect is retryable (ensure() un-memoizes rejections)
//      and never crashes the serve process.
//
// Same stubbing discipline as serve-stdio-lifecycle.test.ts: no real Bun
// child, no real MCP SDK, injected exit/log/stdin.

class StubEngine implements Partial<BrainEngine> {
  disconnectCalls = 0;
  disconnect = async (): Promise<void> => {
    this.disconnectCalls += 1;
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const asEngine = (s: StubEngine) => s as unknown as BrainEngine;

describe('createEngineProvider', () => {
  test('pre-connected engine: ensure() resolves it immediately, peek() is non-null', async () => {
    const engine = new StubEngine();
    const p = createEngineProvider(asEngine(engine));
    expect(p.peek()).toBe(asEngine(engine));
    expect(p.inFlight()).toBeNull();
    expect(await p.ensure()).toBe(asEngine(engine));
  });

  test('lazy connector: concurrent ensure() calls share one connect', async () => {
    const engine = new StubEngine();
    let connects = 0;
    const d = deferred<BrainEngine>();
    const p = createEngineProvider(() => { connects += 1; return d.promise; });

    expect(p.peek()).toBeNull();
    const a = p.ensure();
    const b = p.ensure();
    expect(p.inFlight()).not.toBeNull();
    expect(connects).toBe(1);

    d.resolve(asEngine(engine));
    expect(await a).toBe(asEngine(engine));
    expect(await b).toBe(asEngine(engine));
    expect(p.peek()).toBe(asEngine(engine));
    expect(p.inFlight()).toBeNull();
    // Post-success ensure() reuses the connected engine, no reconnect.
    await p.ensure();
    expect(connects).toBe(1);
  });

  test('failed connect clears the memo — next ensure() retries', async () => {
    // The retry is the load-bearing degradation: a lock held by a
    // finishing CLI process frees up, and the next tools/call succeeds
    // instead of the server staying dead until restart.
    const engine = new StubEngine();
    let connects = 0;
    const p = createEngineProvider(async () => {
      connects += 1;
      if (connects === 1) throw new Error('GBrain: Timed out waiting for PGLite lock.');
      return asEngine(engine);
    });

    await expect(p.ensure()).rejects.toThrow(/PGLite lock/);
    expect(p.peek()).toBeNull();

    expect(await p.ensure()).toBe(asEngine(engine));
    expect(connects).toBe(2);
  });

  test('disconnect() awaits an in-flight connect, then disconnects (lock-leak regression)', async () => {
    const engine = new StubEngine();
    const d = deferred<BrainEngine>();
    const p = createEngineProvider(() => d.promise);

    void p.ensure().catch(() => {});
    let disconnected = false;
    const done = p.disconnect().then(() => { disconnected = true; });

    // Connect still in flight — disconnect must NOT have completed (the
    // old behavior tore down "around" the in-flight connect, releasing
    // nothing; the connect then completed and leaked the lock dir).
    await Promise.resolve();
    expect(disconnected).toBe(false);
    expect(engine.disconnectCalls).toBe(0);

    d.resolve(asEngine(engine));
    await done;
    expect(engine.disconnectCalls).toBe(1);
    expect(p.peek()).toBeNull();
  });

  test('disconnect() when connect was never started is a no-op (engine never boots)', async () => {
    let connects = 0;
    const p = createEngineProvider(async () => {
      connects += 1;
      return asEngine(new StubEngine());
    });
    await p.disconnect();
    expect(connects).toBe(0);
  });

  test('disconnect() after a FAILED connect resolves without booting anything', async () => {
    const p = createEngineProvider(async () => {
      throw new Error('connect refused');
    });
    void p.ensure().catch(() => {});
    await p.disconnect(); // must not throw — there is nothing to release
    expect(p.peek()).toBeNull();
  });

  test('disconnect() propagates engine.disconnect errors (callers log them)', async () => {
    const engine = new StubEngine();
    engine.disconnect = async () => { throw new Error('synthetic disconnect failure'); };
    const p = createEngineProvider(asEngine(engine));
    await expect(p.disconnect()).rejects.toThrow('synthetic disconnect failure');
  });

  test('isEngineProvider distinguishes providers from bare engines', () => {
    const engine = asEngine(new StubEngine());
    expect(isEngineProvider(engine)).toBe(false);
    expect(isEngineProvider(createEngineProvider(engine))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runServe stdio integration with a lazy connector
// ---------------------------------------------------------------------------

interface LazyHarness {
  stdin: EventEmitter & { isTTY?: boolean };
  logs: string[];
  exited: Promise<number>;
  opts: ServeOptions;
  startedWith: Array<BrainEngine | EngineProvider>;
}

function makeLazyHarness(): LazyHarness {
  const stdin = new EventEmitter() as EventEmitter & { isTTY?: boolean };
  const logs: string[] = [];
  const startedWith: Array<BrainEngine | EngineProvider> = [];

  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(r => { resolveExit = r; });
  let exitCalled = false;

  const opts: ServeOptions = {
    stdin: stdin as any,
    signals: new EventEmitter() as any,
    exit: (code?: number) => {
      if (exitCalled) return;
      exitCalled = true;
      resolveExit(code ?? 0);
    },
    log: (msg: string) => { logs.push(msg); },
    startMcpServer: async (e) => { startedWith.push(e); },
    // Pin the watchdog out of the way — these tests drive stdin events.
    getParentPid: () => 1,
    probeWatchdog: () => true,
  };

  return { stdin, logs, exited, opts, startedWith };
}

describe('runServe stdio with a lazy connector (#2091)', () => {
  test('startMcpServer is reached while the engine connect is still in flight', async () => {
    const h = makeLazyHarness();
    const engine = new StubEngine();
    const d = deferred<BrainEngine>();

    await runServe(() => d.promise, [], h.opts);

    // runServe returned — the MCP layer is up — and the engine is NOT
    // connected yet. This is the inversion that lets initialize answer
    // within the host's connect timeout regardless of PGLite boot time.
    expect(h.startedWith.length).toBe(1);
    const provider = h.startedWith[0] as EngineProvider;
    expect(isEngineProvider(provider)).toBe(true);
    expect(provider.peek()).toBeNull();
    expect(provider.inFlight()).not.toBeNull();

    // Background connect lands; the provider memoizes it.
    d.resolve(asEngine(engine));
    expect(await provider.ensure()).toBe(asEngine(engine));
    expect(provider.peek()).toBe(asEngine(engine));
  });

  test('MCP_STDIO durable mode does not warm/connect until real work arrives (#2458)', async () => {
    const h = makeLazyHarness();
    h.opts.mcpStdio = true;
    let connects = 0;

    await runServe(async () => {
      connects += 1;
      return asEngine(new StubEngine());
    }, [], h.opts);

    expect(h.startedWith.length).toBe(1);
    const provider = h.startedWith[0] as EngineProvider;
    expect(isEngineProvider(provider)).toBe(true);
    expect(provider.peek()).toBeNull();
    expect(provider.inFlight()).toBeNull();
    expect(connects).toBe(0);
  });

  test('shutdown racing the in-flight connect still disconnects the engine', async () => {
    // The production incident: host killed the serve while PGLite was
    // booting; disconnect ran before the lock was acquired, the in-flight
    // connect then acquired it, and the lock dir leaked. The provider
    // awaits the in-flight connect inside disconnect(), so the engine the
    // connect produces is the engine that gets torn down.
    const h = makeLazyHarness();
    const engine = new StubEngine();
    const d = deferred<BrainEngine>();

    await runServe(() => d.promise, [], h.opts);

    // Host disconnects while connect is still pending.
    h.stdin.emit('end');
    await Promise.resolve();
    expect(engine.disconnectCalls).toBe(0); // waiting on the in-flight connect

    // The boot completes after the shutdown began — exactly the leak window.
    d.resolve(asEngine(engine));
    const code = await h.exited;

    expect(code).toBe(0);
    expect(engine.disconnectCalls).toBe(1);
    expect(h.logs.some(l => l.includes('graceful exit (stdin-end)'))).toBe(true);
  });

  test('connector rejection logs a retry hint and a later shutdown exits cleanly', async () => {
    const h = makeLazyHarness();
    let connects = 0;
    await runServe(async () => {
      connects += 1;
      throw new Error('GBrain: Timed out waiting for PGLite lock.');
    }, [], h.opts);

    // Give the background ensure() a turn to reject and be logged.
    await new Promise(r => setTimeout(r, 0));
    expect(connects).toBe(1);
    expect(h.logs.some(l => l.includes('engine connect failed (will retry on first tool call)'))).toBe(true);

    // Shutdown after a failed connect: nothing to release, clean exit 0.
    h.stdin.emit('end');
    const code = await h.exited;
    expect(code).toBe(0);
  });

  test('bare-engine callers are unchanged (provider pre-resolved)', async () => {
    const h = makeLazyHarness();
    const engine = new StubEngine();

    await runServe(asEngine(engine), [], h.opts);

    const provider = h.startedWith[0] as EngineProvider;
    expect(provider.peek()).toBe(asEngine(engine));

    h.stdin.emit('end');
    const code = await h.exited;
    expect(code).toBe(0);
    expect(engine.disconnectCalls).toBe(1);
  });
});
