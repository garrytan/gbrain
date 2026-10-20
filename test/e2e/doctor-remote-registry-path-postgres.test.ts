/**
 * Wave 20 review: the remote doctor (run_doctor / gbrain remote doctor) must
 * not show a remote caller the brain host's filesystem path to the worker
 * registry when that registry can't be read. The local doctor keeps it.
 *
 * Run: DATABASE_URL=... bun test test/e2e/doctor-remote-registry-path-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { doctorReportRemote } from '../../src/commands/doctor.ts';
import { workerRegistryDir } from '../../src/core/minions/worker-registry.ts';
import { withEnv } from '../helpers/with-env.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;
let engine: PostgresEngine;
let home: string;

describeE2E('remote doctor withholds the worker registry path (Postgres)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    home = mkdtempSync(join(tmpdir(), 'gbrain-remote-registry-'));
    await engine.executeRaw(
      `INSERT INTO minion_jobs (submission_authority, name, queue, status, created_at, updated_at)
       VALUES ('{"version":1,"kind":"application"}'::jsonb, 'embed-backfill', 'default', 'waiting', now() - interval '3 hours', now())`,
    );
  }, 120_000);
  afterAll(async () => {
    await teardownDB();
    rmSync(home, { recursive: true, force: true });
  });

  test('queue_health names the path to the local doctor only', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const dir = workerRegistryDir();
      mkdirSync(dirname(dir), { recursive: true });
      writeFileSync(dir, 'not a directory');

      const remote = await doctorReportRemote(engine, { remote: true });
      const remoteCheck = remote.checks.find((c) => c.name === 'queue_health')!;
      expect(remoteCheck.details).toMatchObject({ worker_alive: null, worker_registry_unreadable: true, worker_registry_errno: 'ENOTDIR', worker_registry_path_redacted: true });
      expect(JSON.stringify(remote)).not.toContain(home);

      const local = await doctorReportRemote(engine, { remote: false });
      const localCheck = local.checks.find((c) => c.name === 'queue_health')!;
      expect(localCheck.details?.worker_registry_path).toBe(dir);
      expect(localCheck.message).toContain(`ENOTDIR at ${dir}`);
    });
  }, 120_000);
});
