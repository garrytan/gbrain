import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { waitForHttpServerLifecycle, type HttpServerLifecycle } from '../src/commands/serve-http.ts';

class FakeHttpServer extends EventEmitter {
  listening = true;
  closeCalls = 0;

  close(callback?: (error?: Error) => void): this {
    this.closeCalls++;
    this.listening = false;
    queueMicrotask(() => {
      callback?.();
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

    const lifecycle = waitForHttpServerLifecycle(server as unknown as HttpServerLifecycle, {
      signals: signals as unknown as NodeJS.Process,
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

    const lifecycle = waitForHttpServerLifecycle(server as unknown as HttpServerLifecycle, {
      signals: signals as unknown as NodeJS.Process,
      register() {
        return () => {};
      },
    });

    signals.emit('SIGINT');
    await lifecycle;

    expect(server.closeCalls).toBe(1);
  });
});
