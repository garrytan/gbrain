/**
 * #5693 on Postgres: the apply-migrations orchestration lock is a renewable
 * lease row in gbrain_cycle_locks, so it holds through a transaction-mode
 * PgBouncer (this file is in scripts/e2e-backend-matrix.txt). A second
 * runner refuses naming the holder's host and pid; a lease left by a dead
 * same-host holder is taken over under the existing db-lock rules.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { hasDatabase, setupDB, teardownDB, getConn } from './helpers.ts';
import { collect, logHas, makeHome, spawnDriver, waitFor, writeDriver } from '../helpers/apply-migrations-lock-driver.ts';
import { MIGRATION_ORCHESTRATION_LOCK_ID } from '../../src/core/migration-orchestration-lock.ts';

const RUN = hasDatabase();
const describeE2E = RUN ? describe : describe.skip;

describeE2E('apply-migrations orchestration lock (Postgres)', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  test('a second runner refuses naming host and pid; only one orchestrator runs', async () => {
    await getConn().unsafe('DELETE FROM gbrain_cycle_locks WHERE id = $1', [MIGRATION_ORCHESTRATION_LOCK_ID]);
    const home = makeHome({ engine: 'postgres', database_url: process.env.DATABASE_URL! });
    try {
      const first = spawnDriver(home, writeDriver(home, { holdMs: 4_000, openDatastore: true }));
      await waitFor(() => logHas(home, 'start'), 60_000);
      const second = await collect(spawnDriver(home, writeDriver(home, { holdMs: 0, openDatastore: false })));
      const firstResult = await collect(first);

      expect(firstResult.code, firstResult.stderr + firstResult.stdout).toBe(0);
      const log = readFileSync(join(home, 'orchestrator.log'), 'utf8');
      expect(log.match(/^start /gm)?.length).toBe(1);
      expect(log).toContain(`opened ${first.pid}`);
      expect(second.code, second.stderr + second.stdout).toBe(75);
      expect(second.stderr).toContain('another apply-migrations is running');
      expect(second.stderr).toContain(`pid ${first.pid}`);
      expect(second.stderr).toContain(`host ${hostname()}`);
      const rows = await getConn().unsafe('SELECT 1 FROM gbrain_cycle_locks WHERE id = $1', [MIGRATION_ORCHESTRATION_LOCK_ID]);
      expect(rows.length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test('a lease left by a dead same-host holder is taken over', async () => {
    await getConn().unsafe(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
       VALUES ($1, 2147483646, $2, NOW() - interval '5 minutes', NOW() + interval '5 minutes', NOW() - interval '5 minutes', gen_random_uuid())
       ON CONFLICT (id) DO UPDATE SET holder_pid = EXCLUDED.holder_pid, holder_host = EXCLUDED.holder_host,
         acquired_at = EXCLUDED.acquired_at, ttl_expires_at = EXCLUDED.ttl_expires_at,
         last_refreshed_at = EXCLUDED.last_refreshed_at, acquisition_token = EXCLUDED.acquisition_token`,
      [MIGRATION_ORCHESTRATION_LOCK_ID, hostname()],
    );
    const home = makeHome({ engine: 'postgres', database_url: process.env.DATABASE_URL! });
    try {
      const next = await collect(spawnDriver(home, writeDriver(home, { holdMs: 0, openDatastore: false })));
      expect(next.code, next.stderr + next.stdout).toBe(0);
      expect(logHas(home, 'end')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test('a runner that lost its lease stops before the next migration and reports the new holder', async () => {
    await getConn().unsafe('DELETE FROM gbrain_cycle_locks WHERE id = $1', [MIGRATION_ORCHESTRATION_LOCK_ID]);
    const home = makeHome({ engine: 'postgres', database_url: process.env.DATABASE_URL! });
    try {
      const run = await collect(spawnDriver(home, writeDriver(home, { holdMs: 0, openDatastore: false, stealLease: true })));
      expect(run.code, run.stderr + run.stdout).toBe(75);
      expect(run.stderr).toContain('host host-b, pid 4242');
      expect(logHas(home, 'start')).toBe(false);
    } finally {
      await getConn().unsafe('DELETE FROM gbrain_cycle_locks WHERE id = $1', [MIGRATION_ORCHESTRATION_LOCK_ID]);
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
