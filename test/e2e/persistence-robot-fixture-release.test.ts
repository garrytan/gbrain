/**
 * The crash robot gives each run its own database. Through a transaction-mode
 * pooler every server connection a run opened stays in that database's pool
 * until the pooler's idle timeout (PgBouncer: 600 s, a full robot budget), so
 * a 600 s run that kept every passed run's database alive until the end
 * crossed `max_connections` at about the 25th run (master f250a517c, the
 * postgres / Bun 1.4.0 cell). The driver now drops a run's database as soon as
 * the run passes, which ends those backends with it.
 *
 * Fails before the fix: the passed run's database is still listed and still
 * exists when the phase returns. After: the list is empty, the database is
 * gone and no backend is attached to it, through the pooler too when
 * GBRAIN_PGBOUNCER_URL names one.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres'
import { crossBoundarySequences } from '../../scripts/persistence/generator.ts';
import { connectionDiagnostic } from '../../scripts/persistence/failure-diagnostics.ts';
import { ROBOT_TOPOLOGY, runRobotPhase, type RobotRun } from '../../scripts/persistence/robot-driver.ts';
import { spawnWorker } from '../../scripts/persistence/validate.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { hasDatabase } from './helpers.ts';

const direct = process.env.DATABASE_URL;
const pooled = process.env.GBRAIN_PGBOUNCER_URL;

describe.skipIf(!hasDatabase())('crash robot fixture databases', () => {
  test(`a passed run's database is dropped before the next run starts${pooled ? ' (through the pooler)' : ''}`, async () => {
    assertSafeE2eDatabaseUrl(direct!);
    const created: string[] = [];
    const admin = postgres(direct!, { max: 1, onnotice() {} });
    const recording = new Proxy(admin, { get(target, key, receiver) {
      if (key !== 'unsafe') return Reflect.get(target, key, receiver);
      return (query: string, ...rest: unknown[]) => {
        const match = /^CREATE DATABASE (\S+)/.exec(query); if (match) created.push(match[1]);
        return (target.unsafe as (...args: unknown[]) => unknown)(query, ...rest);
      };
    } }) as typeof admin;
    const scratch = mkdtempSync(join(tmpdir(), 'gbrain-robot-release-')); const home = join(scratch, 'home');
    const children: ReturnType<typeof spawnWorker>[] = []; const databases: string[] = [];
    const schedule = crossBoundarySequences(ROBOT_TOPOLOGY, 5105)[0];
    const replay: RobotRun[] = [{ schedule: schedule.label, seed: schedule.seed, length: schedule.ops.length, crashed: false, violations: [], duration_ms: 0 }];
    try {
      const result = await runRobotPhase({ engine: 'postgres', seed: 5105, seconds: 0, scratch, home, admin: recording, databaseUrl: direct, databases,
        pooledUrl: pooled, spawn: spawnWorker, track: child => { children.push(child); }, replay, log() {} });
      expect(result.runs.map(run => run.violations)).toEqual([[]]);
      expect(created).toHaveLength(1);
      const [attached] = await admin`SELECT count(*)::int AS backends FROM pg_stat_activity WHERE datname = ${created[0]}`;
      expect(attached.backends).toBe(0);
      const [exists] = await admin`SELECT count(*)::int AS databases FROM pg_database WHERE datname = ${created[0]}`;
      expect(exists.databases).toBe(0);
      expect(databases).toEqual([]);
    } finally {
      await Promise.allSettled(children.map(child => child.kill()));
      for (const database of databases) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  test('the connection diagnostic reports slots by database class, state and wait class only', async () => {
    const admin = postgres(direct!, { max: 1, onnotice() {} });
    try {
      await admin`SELECT 1`;
      const report = await connectionDiagnostic(admin);
      expect(report.max_connections).toMatch(/^\d+$/);
      expect(report.backends).toBeGreaterThanOrEqual(1);
      expect(report.groups.some(group => group.databases === 'other' && group.state === 'active')).toBe(true);
      for (const group of report.groups) expect(Object.keys(group).sort()).toEqual(['backends', 'database_count', 'databases', 'state', 'wait_event_type']);
    } finally { await admin.end(); }
  });
});
