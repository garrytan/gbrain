/**
 * #5693: two `gbrain apply-migrations` runners must never orchestrate the same
 * brain at once. The first runner holds the orchestration lock through its
 * final status; a second runner refuses, naming the holder's host and pid,
 * and exits with the "already running" status instead of re-running every
 * orchestrator in parallel. On PGLite the lock is a separate native lock
 * file, so the holder's own orchestrators can still open the datastore.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { collect, makeHome, spawnDriver, waitFor, writeDriver } from './helpers/apply-migrations-lock-driver.ts';

describe('apply-migrations orchestration lock (PGLite)', () => {
  test('a second runner refuses naming host and pid while the holder\'s orchestrators open the datastore', async () => {
    const home = makeHome({ engine: 'pglite' });
    try {
      const logPath = join(home, 'orchestrator.log');
      const first = spawnDriver(home, writeDriver(home, { holdMs: 4_000, openDatastore: true }));
      await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('start'), 60_000);
      const second = await collect(spawnDriver(home, writeDriver(home, { holdMs: 0, openDatastore: false })));
      const firstResult = await collect(first);

      expect(firstResult.code, firstResult.stderr + firstResult.stdout).toBe(0);
      const log = readFileSync(logPath, 'utf8');
      expect(log.match(/^start /gm)?.length).toBe(1);
      expect(log).toContain(`opened ${first.pid}`);
      expect(second.code, second.stderr + second.stdout).toBe(75);
      expect(second.stderr).toContain('another apply-migrations is running');
      expect(second.stderr).toContain(`pid ${first.pid}`);
      expect(second.stderr).toContain(`host ${hostname()}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test('a holder that died is taken over and the next run proceeds', async () => {
    const home = makeHome({ engine: 'pglite' });
    try {
      const logPath = join(home, 'orchestrator.log');
      const first = spawnDriver(home, writeDriver(home, { holdMs: 60_000, openDatastore: false }));
      await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('start'), 60_000);
      first.kill('SIGKILL');
      await first.exited;
      const next = await collect(spawnDriver(home, writeDriver(home, { holdMs: 0, openDatastore: false })));
      expect(next.code, next.stderr + next.stdout).toBe(0);
      expect(readFileSync(logPath, 'utf8').match(/^end /gm)?.length).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test('a competing runner that later fails releases the lock, and the next run proceeds', async () => {
    const home = makeHome({ engine: 'pglite' });
    try {
      const logPath = join(home, 'orchestrator.log');
      const first = spawnDriver(home, writeDriver(home, { holdMs: 2_000, openDatastore: false, fail: true }));
      await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('start'), 60_000);
      const refused = await collect(spawnDriver(home, writeDriver(home, { holdMs: 0, openDatastore: false })));
      const failed = await collect(first);
      expect(refused.code, refused.stderr).toBe(75);
      expect(failed.code, failed.stderr + failed.stdout).toBe(1);
      const next = await collect(spawnDriver(home, writeDriver(home, { holdMs: 0, openDatastore: false })));
      expect(next.code, next.stderr + next.stdout).toBe(0);
      expect(readFileSync(logPath, 'utf8').match(/^start /gm)?.length).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test('a previous release\'s postinstall run that completed leaves the post-upgrade run a no-op', async () => {
    const home = makeHome({ engine: 'pglite' });
    try {
      const postinstallRun = await collect(spawnDriver(home, writeDriver(home, { holdMs: 0, openDatastore: false })));
      const postUpgradeRun = await collect(spawnDriver(home, writeDriver(home, { holdMs: 0, openDatastore: false })));
      expect(postinstallRun.code, postinstallRun.stderr).toBe(0);
      expect(postUpgradeRun.code, postUpgradeRun.stderr).toBe(0);
      expect(postUpgradeRun.stdout).toContain('All migrations up to date.');
      expect(readFileSync(join(home, 'orchestrator.log'), 'utf8').match(/^start /gm)?.length).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
