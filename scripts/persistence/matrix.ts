import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import { assertSafeE2eDatabaseUrl } from '../../test/helpers/db-guard.ts';
import { spawnWorker } from './validate.ts';
import type { RuntimeCase } from './matrix-cases.ts';

export async function runRuntimeMatrix(options: { directUrl: string; pooledUrl: string; manifest?: string }) {
  assertSafeE2eDatabaseUrl(options.directUrl); assertSafeE2eDatabaseUrl(options.pooledUrl);
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-persistence-matrix-')); const home = join(scratch, 'home'); mkdirSync(home);
  // Other E2E shards disconnect clients of their shared test database between
  // files. Keep only CREATE/DROP DATABASE/ROLE control on the maintenance DB;
  // all engine activity uses the fresh test databases recorded below.
  const controlUrl = new URL(options.directUrl); controlUrl.pathname = '/postgres';
  const admin = postgres(controlUrl.toString(), { max: 1, onnotice() {} });
  const databases: string[] = []; const roles: string[] = []; const children: ReturnType<typeof spawnWorker>[] = [];
  const manifest: Record<string, any> = { version: 1, runtime: `bun-${Bun.version}`, platform: process.platform,
    architecture: process.arch, managed_persistence: true, started_at: new Date().toISOString(), status: 'running', cases: [], ownership: null };
  function start(path: string, role: string, env: Record<string, string> = {}) {
    const child = spawnWorker(path, home, role, [], env); children.push(child); return child;
  }
  try {
    for (const route of ['direct', 'pgbouncer'] as const) for (const rls of [false, true]) for (const poolSize of [1, 2, 3]) for (const dual of [false, true]) {
      const token = randomUUID().replaceAll('-', ''); const database = `gbrain_persistence_test_${token}`; const role = `gbrain_persistence_test_role_${token}`;
      await admin.unsafe(`CREATE DATABASE ${database}`); databases.push(database);
      await admin.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`); roles.push(role);
      const direct = new URL(options.directUrl); direct.pathname = `/${database}`;
      const pooled = new URL(options.pooledUrl); pooled.pathname = `/${database}`;
      const root = join(scratch, token); mkdirSync(root);
      const config: RuntimeCase = { kind: 'postgres', root, dataDir: join(root, 'unused'), databaseUrl: direct.toString(),
        hostId: randomUUID(), seed: 5105, schedules: 0, operations: 0, poolSize: 3, seedReadProbe: true,
        sourceIds: Array.from({ length: 4 }, (_, i) => `matrix-test-${i}`), principalIds: Array.from({ length: 4 }, () => randomUUID()), route, rls, dual, role };
      const path = join(root, 'config.json'); writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
      await start(path, 'initialize').done();
      config.databaseUrl = route === 'pgbouncer' ? pooled.toString() : direct.toString(); config.poolSize = poolSize;
      writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
      const result = await start(path, 'runtime-matrix', { GBRAIN_RLS_SCOPE_BINDING: rls ? '1' : '0',
        GBRAIN_DISABLE_DIRECT_POOL: dual ? '0' : '1', GBRAIN_DIRECT_DATABASE_URL: direct.toString(), GBRAIN_DIRECT_POOL_SIZE: '1',
        // Nonstandard fixture pooler port: use the documented explicit override.
        GBRAIN_PREPARE: route === 'pgbouncer' ? 'false' : 'true' }).done();
      manifest.cases.push(result.result);
      process.stderr.write(`[persistence matrix] ${route}, RLS=${rls}, ordinary=${poolSize}, dual=${dual}: passed\n`);
      if (manifest.ownership === null) {
        // Another fresh database keeps queued pool-size-one work out of transfer assertions.
        const ownershipDb = `gbrain_persistence_test_${randomUUID().replaceAll('-', '')}`;
        await admin.unsafe(`CREATE DATABASE ${ownershipDb}`); databases.push(ownershipDb);
        const ownerUrl = new URL(options.directUrl); ownerUrl.pathname = `/${ownershipDb}`;
        const ownerRoot = join(scratch, 'ownership'); mkdirSync(ownerRoot);
        const owner = { ...config, root: ownerRoot, databaseUrl: ownerUrl.toString(), poolSize: 3 };
        const ownerPath = join(ownerRoot, 'config.json'); writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
        await start(ownerPath, 'initialize').done(); manifest.ownership = (await start(ownerPath, 'ownership-matrix').done()).result;
      }
    }
    assert.equal(manifest.cases.length, 24); manifest.status = 'passed'; manifest.full_gate = true; return manifest;
  } catch (error) { manifest.status = 'failed'; manifest.full_gate = false; manifest.failure = String(error); throw error; }
  finally {
    await Promise.allSettled(children.map(child => child.kill()));
    for (const database of databases) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of roles) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`); await admin.end();
    manifest.finished_at = new Date().toISOString();
    if (options.manifest) { mkdirSync(dirname(resolve(options.manifest)), { recursive: true }); writeFileSync(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`); }
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const manifest = process.argv.find(arg => arg.startsWith('--manifest='))?.slice('--manifest='.length) ?? '.context/persistence-runtime-matrix.json';
  assert(process.env.DATABASE_URL && process.env.GBRAIN_PGBOUNCER_URL, 'DATABASE_URL and GBRAIN_PGBOUNCER_URL are required; mandatory matrix cases cannot skip');
  process.stdout.write(`${JSON.stringify(await runRuntimeMatrix({ directUrl: process.env.DATABASE_URL, pooledUrl: process.env.GBRAIN_PGBOUNCER_URL, manifest }), null, 2)}\n`);
}
