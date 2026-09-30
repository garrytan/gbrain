import { describe, expect, test } from 'bun:test';
import { PostgresEngine, hasPostgresCancellationCapability } from '../src/core/postgres-engine.ts';
import { isLocalConfigurationError } from '../src/core/minions/configuration-error.ts';
import { reserveWithCancellation } from '../src/core/postgres-engine/cancellation.ts';

describe('Postgres cancellation runtime owner capability', () => {
  test('validates the reserved owner, while unsignalled diagnostics remain usable', async () => {
    let releases = 0;
    let executions = 0;
    const owner = { release: () => { releases++; }, unsafe: async () => { executions++; return [{ ok: 1 }]; } };
    const engine = new PostgresEngine();
    Object.defineProperty(engine, '_sql', { value: { discard() {}, reserve: async () => owner, unsafe: owner.unsafe } });
    expect(hasPostgresCancellationCapability(owner)).toBe(false);
    expect(await engine.executeRaw('SELECT 1')).toEqual([{ ok: 1 }]);
    try {
      await engine.executeRaw('SELECT 1', [], { signal: new AbortController().signal });
      throw new Error('Expected a configuration error');
    } catch (error) {
      expect(isLocalConfigurationError(error)).toBe(true);
      if (isLocalConfigurationError(error)) expect(error.reasonCode).toBe('postgres_cancellation_unavailable');
    }
    expect(executions).toBe(1);
    expect(releases).toBe(1);
  });

  test('pre-aborted reserve never acquires a slot', async () => {
    const controller = new AbortController();
    controller.abort();
    let acquired = false;
    await expect(reserveWithCancellation(async () => { acquired = true; return { release() {} }; }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(acquired).toBe(false);
  });

  test('unsupported driver reserve is bounded and late ownership is released once', async () => {
    const controller = new AbortController();
    let resolve!: (owner: { release(): void }) => void;
    let releases = 0;
    const reservation = reserveWithCancellation(() => new Promise<{ release(): void }>(done => { resolve = done; }), controller.signal);
    controller.abort();
    await expect(reservation).rejects.toMatchObject({ name: 'AbortError' });
    resolve({ release: () => { releases++; } });
    await Promise.resolve();
    await Promise.resolve();
    expect(releases).toBe(1);
  });
});
