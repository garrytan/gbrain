import { describe, expect, test } from 'bun:test';
import { startRun } from '../src/commands/natural-lang/executor.ts';

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
});
