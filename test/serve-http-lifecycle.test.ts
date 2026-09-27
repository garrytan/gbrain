import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { waitForHttpServerLifecycle } from '../src/commands/serve-http.ts';
import { finishHttpServe } from '../src/commands/serve.ts';

class FakeHttpServer extends EventEmitter {
  listening = true;
  closeCalls = 0;
  /** Real servers can fail the close callback and still emit 'close'. */
  closeError: Error | undefined;

  close(callback?: (error?: Error) => void): this {
    this.closeCalls++;
    this.listening = false;
    queueMicrotask(() => {
      callback?.(this.closeError);
      this.emit('close');
    });
    return this;
  }
}

describe('HTTP server lifecycle', () => {
  test('waits for shared cleanup to close the server', async () => {
    const server = new FakeHttpServer();
    const signals = new EventEmitter();
    let cleanup: (() => Promise<void>) | undefined;
    let deregistered = false;
    let resolved = false;

    const lifecycle = waitForHttpServerLifecycle(server, {
      signals,
      register(_name, fn) {
        cleanup = fn;
        return () => { deregistered = true; };
      },
    }).then(() => { resolved = true; });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(cleanup).toBeDefined();

    await cleanup!();
    await lifecycle;

    expect(server.closeCalls).toBe(1);
    expect(deregistered).toBe(true);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  test('SIGINT closes the server through the same idempotent path', async () => {
    const server = new FakeHttpServer();
    const signals = new EventEmitter();

    const lifecycle = waitForHttpServerLifecycle(server, {
      signals,
      register() {
        return () => {};
      },
    });

    signals.emit('SIGINT');
    await lifecycle;

    expect(server.closeCalls).toBe(1);
  });

  // The shipped hang: `close()` waits for open connections to drain, and an
  // attached admin-SSE stream never drains. A fake whose close() always
  // succeeds on the next microtask cannot observe that, so pin the teardown
  // itself — this is a change-detector for the severing, and the real proof is
  // a spawned-process signal run.
  test('severs live connections so close() cannot block on them', async () => {
    const server = new FakeHttpServer();
    const signals = new EventEmitter();

    const live = { destroyed: false, destroy() { this.destroyed = true; }, once() {} };
    const gone = { destroyed: false, destroy() { this.destroyed = true; }, once(_e: string, cb: () => void) { cb(); } };

    const lifecycle = waitForHttpServerLifecycle(server, {
      signals,
      register() { return () => {}; },
    });

    server.emit('connection', live);
    server.emit('connection', gone); // deregisters itself immediately via 'close'

    signals.emit('SIGINT');
    await lifecycle;

    expect(live.destroyed).toBe(true);
    // Already-closed sockets are dropped from the set, so shutdown does not
    // touch them — destroying a dead socket is harmless but the bookkeeping
    // leaking would not be.
    expect(gone.destroyed).toBe(false);
  });

  // A native Promise already settles once, so asserting resolve-count proves
  // nothing about the `settled` guard. What the guard actually protects is
  // finish()'s SIDE EFFECTS — deregistering the shared-cleanup entry, and
  // detaching listeners. Deregistering twice removes an entry a later caller
  // may have re-registered.
  //
  // The real double-finish path: SIGINT calls closeServer(); the close callback
  // reports an error (rejecting that promise, whose .catch routes to onError)
  // while the server also emits 'close' (routing to onClose). Both reach
  // finish() from the same close.
  test('runs shutdown side effects once when close both fails and emits close', async () => {
    const server = new FakeHttpServer();
    server.closeError = new Error('close reported a failure');
    const signals = new EventEmitter();
    let deregisterCalls = 0;
    let settlements = 0;

    const lifecycle = waitForHttpServerLifecycle(server, {
      signals,
      register() { return () => { deregisterCalls++; }; },
    }).then(() => { settlements++; }, () => { settlements++; });

    signals.emit('SIGINT');
    await lifecycle;
    // Let the rejected closeServer promise deliver its .catch(onError) — the
    // second finish() attempt lands here, after the first already settled.
    await new Promise((r) => setTimeout(r, 0));

    expect(deregisterCalls).toBe(1);
    expect(settlements).toBe(1);
    expect(server.closeCalls).toBe(1);
    expect(server.listenerCount('close')).toBe(0);
    expect(server.listenerCount('error')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  // Sockets are held weakly (Bun never emits 'close' on them), so destroyAll()
  // can only sever wrappers still reachable. An idle keep-alive wrapper the
  // runtime already collected leaves its native handle keeping close() waiting
  // forever — the same hang the severing fixed, from the other side. The
  // lifecycle bounds that wait instead of trusting close() to return.
  test('bounds a close() that never finishes, says so, and still completes the lifecycle', async () => {
    const server = new FakeHttpServer();
    server.close = function (this: FakeHttpServer) {
      this.closeCalls++;
      this.listening = false;
      return this; // never calls back, never emits 'close'
    };
    const signals = new EventEmitter();
    const logs: string[] = [];
    let deregistered = false;

    const lifecycle = waitForHttpServerLifecycle(server, {
      signals,
      register() { return () => { deregistered = true; }; },
      closeTimeoutMs: 20,
      log: (msg) => { logs.push(msg); },
    });

    signals.emit('SIGINT');
    const outcome = await Promise.race([
      lifecycle.then(() => 'settled'),
      new Promise<string>((r) => setTimeout(() => r('hung'), 500)),
    ]);

    expect(outcome).toBe('settled');
    expect(server.closeCalls).toBe(1);
    expect(deregistered).toBe(true);
    expect(logs.join('\n')).toMatch(/20ms/);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  test('a close() error that lands after the deadline is logged, not dropped', async () => {
    const server = new FakeHttpServer();
    server.close = function (this: FakeHttpServer, callback?: (error?: Error) => void) {
      this.closeCalls++;
      this.listening = false;
      setTimeout(() => callback?.(new Error('late close failure')), 40); // after the 20ms deadline
      return this;
    };
    const signals = new EventEmitter();
    const logs: string[] = [];

    const lifecycle = waitForHttpServerLifecycle(server, {
      signals,
      register() { return () => {}; },
      closeTimeoutMs: 20,
      log: (msg) => { logs.push(msg); },
    });
    signals.emit('SIGINT');
    await lifecycle; // resolved by the deadline
    await new Promise((r) => setTimeout(r, 60)); // let the late callback fire

    expect(logs.join('\n')).toMatch(/20ms/);
    expect(logs.join('\n')).toContain('late close failure');
  });
});

// Severing sockets lets close() finish; this is what actually stops the
// process. Without it the serve path returns to a caller that never tears the
// engine down, and the orphan keeps the PGLite write lock — which is the
// user-visible failure (every later CLI write is refused).
describe('HTTP serve teardown', () => {
  const codes = () => {
    const exits: number[] = [];
    const logs: string[] = [];
    return { exits, logs, opts: { exit: (c?: number) => { exits.push(c ?? 0); }, log: (m: string) => { logs.push(m); } } };
  };

  test('disconnects the engine before exiting', async () => {
    const order: string[] = [];
    const { exits, opts } = codes();
    await finishHttpServe(
      { disconnect: async () => { order.push('disconnect'); } },
      { ...opts, exit: (c?: number) => { order.push('exit'); exits.push(c ?? 0); } },
    );
    // Disconnect FIRST — exiting before the checkpoint is what leaves a store
    // needing recovery.
    expect(order).toEqual(['disconnect', 'exit']);
    expect(exits).toEqual([0]);
  });

  test('still exits when disconnect throws, and says why', async () => {
    const { exits, logs, opts } = codes();
    await finishHttpServe(
      { disconnect: async () => { throw new Error('pool already destroyed'); } },
      opts,
    );
    expect(exits).toEqual([0]);
    expect(logs.join('\n')).toContain('pool already destroyed');
  });

  test('exits exactly once when disconnect outlives the deadline', async () => {
    const { exits, logs, opts } = codes();
    let release: (() => void) | undefined;
    const wedged = new Promise<void>((r) => { release = r; });

    const done = finishHttpServe({ disconnect: () => wedged }, { ...opts, deadlineMs: 5 });
    await new Promise((r) => setTimeout(r, 30)); // deadline fires here
    expect(exits).toEqual([0]);
    expect(logs.join('\n')).toContain('cleanup deadline');

    release!(); // the wedged disconnect finally returns
    await done;
    // A second exit here would be the bug: production's process.exit never
    // returns, so this path is only reachable through the injected seam.
    expect(exits).toEqual([0]);
  });
});
