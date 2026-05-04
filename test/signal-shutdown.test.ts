import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { installEngineSignalShutdown, signalExitCode } from '../src/core/signal-shutdown.ts';

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;

  exit(code?: number): never {
    this.exitCode = code ?? 0;
    return undefined as never;
  }
}

describe('signal shutdown', () => {
  test('maps interrupt and terminate signals to shell-compatible exit codes', () => {
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
  });

  test('disconnects the engine before exiting on SIGTERM', async () => {
    const events: string[] = [];
    const fakeProcess = new FakeProcess();
    const engine = {
      async disconnect() {
        events.push('disconnect');
      },
    };

    installEngineSignalShutdown(engine, {
      process: fakeProcess as unknown as NodeJS.Process,
      exit: (code) => fakeProcess.exit(code),
      log: () => {},
    });

    fakeProcess.emit('SIGTERM');
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(['disconnect']);
    expect(fakeProcess.exitCode).toBe(143);
  });

  test('SIGINT uses exit code 130 after cleanup', async () => {
    const fakeProcess = new FakeProcess();
    const engine = {
      async disconnect() {},
    };

    installEngineSignalShutdown(engine, {
      process: fakeProcess as unknown as NodeJS.Process,
      exit: (code) => fakeProcess.exit(code),
      log: () => {},
    });

    fakeProcess.emit('SIGINT');
    await Promise.resolve();
    await Promise.resolve();

    expect(fakeProcess.exitCode).toBe(130);
  });
});
