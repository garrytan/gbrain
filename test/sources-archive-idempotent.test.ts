/**
 * #2792 — `gbrain sources archive` idempotency.
 *
 * Pre-fix, archiving an already-archived source collapsed into the same
 * reasonless "Failed to archive" exit-4 path as a DB error, pushing operators
 * toward the destructive `sources remove`. Already-archived is now a friendly
 * no-op (exit 0); not-found stays a clear exit-4 error.
 *
 * Runs against PGLite like test/destructive-guard.test.ts (same contract on
 * Postgres; PGLite is fast + DATABASE_URL-free).
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  // Cold-init schema path so the archive columns exist (same intent as
  // destructive-guard tests, but env-isolated per check-test-isolation R1).
  await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => {
    await engine.connect({});
    await engine.initSchema();
  });
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    ['arch-idem', 'arch-idem'],
  );
});

afterAll(async () => {
  await engine.disconnect();
});

function captureRun(args: string[]): Promise<{ logs: string[]; errs: string[]; exit: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  let exit: number | null = null;
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never);
  return runSources(engine, args)
    .catch((e: Error) => {
      if (!e.message.startsWith('EXIT:')) throw e;
    })
    .then(() => ({ logs, errs, exit }))
    .finally(() => {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    });
}

describe('#2792 — sources archive is idempotent', () => {
  test('first archive succeeds', async () => {
    const { exit, logs } = await captureRun(['archive', 'arch-idem']);
    expect(exit).toBeNull();
    expect(logs.join('\n')).toContain('arch-idem');
  });

  test('second archive is a friendly no-op, exit 0, and points at restore/archived', async () => {
    const { exit, logs, errs } = await captureRun(['archive', 'arch-idem']);
    expect(exit).toBeNull(); // no process.exit — success path
    const out = logs.join('\n');
    expect(out).toContain('already archived');
    expect(out).toContain('gbrain sources restore arch-idem');
    expect(errs.join('\n')).not.toContain('Failed to archive');
  });

  test('unknown source still fails loud with exit 4', async () => {
    const { exit, errs } = await captureRun(['archive', 'no-such-source-xyz']);
    expect(exit).toBe(4);
    expect(errs.join('\n')).toContain('not found');
  });
});
