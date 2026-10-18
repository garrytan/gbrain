/**
 * src/commands/migrations/run-engine.ts: consecutive migrations of one
 * apply-migrations run share one PGLite open, and the datastore lock is never
 * held when anything else needs it.
 *
 * Authoring gate:
 *  1. Protects: sharing only while enabled; release before a non-sharing step,
 *     before a `gbrain` child, and at the end of the session; every open outside
 *     a session is a new engine closed by its caller.
 *  2. Fails on: a shared engine left open past the session or a disabled step
 *     (a second process could not open the brain), or a shared open that starts
 *     a second embedded Postgres instead of reusing the first.
 *  3. The setup ledger golden in test/setup.test.ts pins that the shared runs
 *     write the same records as before.
 *  4. No seams: real PGLite datastores in temp directories.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GBrainConfig } from '../src/core/config.ts';
import { peekLock } from '../src/core/pglite-lock.ts';
import { connectMigrationEngine, releaseRunEngine, setRunEngineSharing, withRunEngineSession } from '../src/commands/migrations/run-engine.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function brain(): GBrainConfig {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-run-engine-'));
  roots.push(root);
  return { engine: 'pglite', database_path: join(root, 'brain.pglite') } as GBrainConfig;
}

/** True when nothing holds the datastore lock, so another process could open the brain now. */
const lockFree = (config: GBrainConfig): boolean => !peekLock(config.database_path).held;

describe('migration run engine', () => {
  test('outside a session every open is its own engine and close releases it', async () => {
    const config = brain();
    const first = await connectMigrationEngine(config);
    await first.close();
    const second = await connectMigrationEngine(config);
    expect(second.engine).not.toBe(first.engine);
    await second.close();
  });

  test('with sharing enabled the run reuses one engine; release, disabling and the session end all close it', async () => {
    const config = brain();
    await withRunEngineSession(async () => {
      await setRunEngineSharing(true);
      const a = await connectMigrationEngine(config);
      await a.close();
      const b = await connectMigrationEngine(config);
      expect(b.engine).toBe(a.engine);
      expect(await b.engine.executeRaw<{ one: number }>('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      expect(lockFree(config)).toBe(false);

      await releaseRunEngine();
      await setRunEngineSharing(false);
      expect(lockFree(config)).toBe(true);

      await setRunEngineSharing(true);
      const c = await connectMigrationEngine(config);
      expect(c.engine).not.toBe(a.engine);
      await setRunEngineSharing(false);
      expect(lockFree(config)).toBe(true);

      await setRunEngineSharing(true);
      await connectMigrationEngine(config);
    });
    expect(lockFree(config)).toBe(true);
  });

  test('a session that throws still closes the shared engine', async () => {
    const config = brain();
    await expect(withRunEngineSession(async () => {
      await setRunEngineSharing(true);
      await connectMigrationEngine(config);
      throw new Error('orchestrator failed');
    })).rejects.toThrow('orchestrator failed');
    expect(lockFree(config)).toBe(true);
  });
});
