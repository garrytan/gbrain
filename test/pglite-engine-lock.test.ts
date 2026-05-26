import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireLock } from '../src/core/pglite-lock.ts';

setDefaultTimeout(20_000);

const TEST_DIR = join(tmpdir(), `mbrain-pglite-engine-lock-${process.pid}`);

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('PGLiteEngine lock cleanup', () => {
  test('disconnect releases the lock even when db.close throws', async () => {
    const engine = new PGLiteEngine() as any;
    const lock = await acquireLock(TEST_DIR);

    engine._lock = lock;
    engine._db = {
      close: async () => {
        throw new Error('simulated close failure');
      },
    };

    await expect(engine.disconnect()).rejects.toThrow('simulated close failure');
    expect(existsSync(join(TEST_DIR, '.mbrain-lock'))).toBe(false);
    expect(engine._lock).toBeNull();
  });
});
