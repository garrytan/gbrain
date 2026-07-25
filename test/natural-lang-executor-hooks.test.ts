import { describe, expect, test } from 'bun:test';
import { PgliteRunCoordinator, startRun } from '../src/commands/natural-lang/executor.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for run state');
    await Bun.sleep(10);
  }
}

describe('natural language child-process hooks', () => {
  test('does not expose a completed run until PGLite reconnection finishes', async () => {
    let releaseReconnect!: () => void;
    const reconnect = new Promise<void>(resolve => {
      releaseReconnect = resolve;
    });
    const run = await startRun(
      'source_add',
      [process.execPath, '-e', 'process.exit(0)'],
      process.cwd(),
      { afterComplete: async () => await reconnect },
    );

    await Bun.sleep(100);
    expect(run.status).toBe('running');
    expect(run.completedAt).toBeNull();

    releaseReconnect();
    await waitFor(() => run.status !== 'running');
    expect(run.status).toBe('completed');
    expect(run.completedAt).not.toBeNull();
  });

  test('reports a reconnect failure instead of a false successful completion', async () => {
    const run = await startRun(
      'source_add',
      [process.execPath, '-e', 'process.exit(0)'],
      process.cwd(),
      { afterComplete: async () => { throw new Error('PGLite unavailable'); } },
    );

    await waitFor(() => run.status !== 'running');
    expect(run.status).toBe('failed');
    expect(run.error).toContain('database reconnection failed');
    expect(run.error).toContain('PGLite unavailable');
  });

  test('serializes PGLite children through disconnect, exit, and reconnect', async () => {
    const coordinator = new PgliteRunCoordinator();
    const events: string[] = [];
    const hooks = {
      acquireExclusive: () => coordinator.acquire(),
      beforeSpawn: async () => { events.push('disconnect'); },
      afterComplete: async () => {
        await Bun.sleep(20);
        events.push('reconnect');
      },
    };

    const first = await startRun(
      'import_path',
      [process.execPath, '-e', 'setTimeout(() => process.exit(0), 80)'],
      process.cwd(),
      hooks,
    );
    const second = await startRun(
      'dream_cycle',
      [process.execPath, '-e', 'process.exit(0)'],
      process.cwd(),
      hooks,
    );

    expect(['queued', 'running']).toContain(first.status);
    expect(second.status).toBe('queued');
    await waitFor(() => first.status === 'completed' && second.status === 'completed');
    expect(events).toEqual(['disconnect', 'reconnect', 'disconnect', 'reconnect']);
  });
});
