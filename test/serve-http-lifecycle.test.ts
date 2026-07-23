import { describe, test, expect } from 'bun:test';
import { installHttpLifecycle } from '../src/commands/serve-http';
import type { BrainEngine } from '../src/core/engine';

// Covers the HTTP-transport lifecycle hooks that release the PGLite write
// lock on SIGTERM/SIGINT/SIGHUP. Before this fix, `runServeHttp` never
// installed any signal handling — killing `gbrain serve --http` (systemd
// stop, a plain `kill`, etc.) left `.gbrain-lock` behind and wedged every
// subsequent `sources`/`sync` call until `--break-lock`. Mirrors
// test/serve-stdio-lifecycle.test.ts's harness for the equivalent stdio fix
// (v0.31.3, #801).

class StubEngine implements Partial<BrainEngine> {
  disconnectCalls = 0;
  disconnectDelayMs = 0;
  disconnect = async (): Promise<void> => {
    this.disconnectCalls += 1;
    if (this.disconnectDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.disconnectDelayMs));
    }
  };
}

class StubSignals {
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  on(signal: string, handler: (...a: unknown[]) => void): this {
    const list = this.handlers.get(signal) ?? [];
    list.push(handler);
    this.handlers.set(signal, list);
    return this;
  }
  emit(signal: string): void {
    for (const h of this.handlers.get(signal) ?? []) h();
  }
}

class StubServer {
  closeCalls = 0;
  close(): this {
    this.closeCalls += 1;
    return this;
  }
}

function makeHarness() {
  const engine = new StubEngine();
  const server = new StubServer();
  const signals = new StubSignals();
  const logs: string[] = [];

  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => { resolveExit = r; });
  let exitCalled = false;

  installHttpLifecycle(engine as unknown as BrainEngine, server, {
    signals: signals as any,
    exit: (code?: number) => {
      if (exitCalled) return;
      exitCalled = true;
      resolveExit(code ?? 0);
    },
    log: (msg: string) => { logs.push(msg); },
  });

  return { engine, server, signals, logs, exited };
}

describe('installHttpLifecycle', () => {
  test('SIGTERM releases the PGLite lock via engine.disconnect()', async () => {
    const { engine, signals, exited } = makeHarness();
    signals.emit('SIGTERM');
    const code = await exited;
    expect(code).toBe(0);
    expect(engine.disconnectCalls).toBe(1);
  });

  test('SIGINT and SIGHUP also trigger graceful shutdown', async () => {
    for (const sig of ['SIGINT', 'SIGHUP']) {
      const { engine, signals, exited } = makeHarness();
      signals.emit(sig);
      await exited;
      expect(engine.disconnectCalls).toBe(1);
    }
  });

  test('stops accepting new connections via server.close()', async () => {
    const { server, signals, exited } = makeHarness();
    signals.emit('SIGTERM');
    await exited;
    expect(server.closeCalls).toBe(1);
  });

  test('duplicate signals are idempotent — disconnect fires once', async () => {
    const { engine, signals, exited } = makeHarness();
    signals.emit('SIGTERM');
    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await exited;
    expect(engine.disconnectCalls).toBe(1);
  });

  test('a wedged engine.disconnect() still exits after the deadline', async () => {
    // HTTP_CLEANUP_DEADLINE_MS is 5s, matching bun test's own default
    // per-test timeout — give this one explicit headroom.
    const engine = new StubEngine();
    engine.disconnectDelayMs = 999_999; // effectively "never resolves" for this test
    const server = new StubServer();
    const signals = new StubSignals();
    const logs: string[] = [];

    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((r) => { resolveExit = r; });
    let exitCalled = false;

    installHttpLifecycle(engine as unknown as BrainEngine, server, {
      signals: signals as any,
      exit: (code?: number) => {
        if (exitCalled) return;
        exitCalled = true;
        resolveExit(code ?? 0);
      },
      log: (msg: string) => { logs.push(msg); },
    });

    signals.emit('SIGTERM');
    const code = await exited;
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('cleanup deadline'))).toBe(true);
  }, 7000);

  test('a disconnect() rejection still exits cleanly and logs the error', async () => {
    const engine: Partial<BrainEngine> = {
      disconnect: async () => { throw new Error('boom'); },
    };
    const server = new StubServer();
    const signals = new StubSignals();
    const logs: string[] = [];

    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((r) => { resolveExit = r; });
    let exitCalled = false;

    installHttpLifecycle(engine as BrainEngine, server, {
      signals: signals as any,
      exit: (code?: number) => {
        if (exitCalled) return;
        exitCalled = true;
        resolveExit(code ?? 0);
      },
      log: (msg: string) => { logs.push(msg); },
    });

    signals.emit('SIGTERM');
    const code = await exited;
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('cleanup error') && l.includes('boom'))).toBe(true);
  });
});
