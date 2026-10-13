import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PgliteOpenError } from '../src/core/pglite-errors.ts';
import { precheckPgliteLock } from '../desktop/src/main/pglite-lock-precheck.js';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const root = mkdtempSync(join(tmpdir(), 'pmbrain-startup-path-engine-'));
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL'];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
for (const key of keys) delete process.env[key];
process.env.PMBRAIN_HOME = root; process.env.GBRAIN_HOME = root;
const url = process.env.PMBRAIN_PATH_TEST_DATABASE_URL;
if (url) assertSafeE2eDatabaseUrl(url);
afterAll(() => {
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
});

test('真实 PGLite 路径冲突即停止，原文件保留；修正路径可重开同一数据库并读回记录', async () => {
  const path = join(root, 'occupied.pglite'), bytes = Buffer.from('Keep the unknown file before and after a startup retry.');
  writeFileSync(path, bytes);
  const failing = new PGLiteEngine();
  await expect(failing.connect({ database_path: path })).rejects.toBeInstanceOf(PgliteOpenError);
  await failing.disconnect();
  expect(readFileSync(path)).toEqual(bytes);
  expect(precheckPgliteLock(path).blocked).toBe(true);
  const datastore = join(root, 'retained.pglite'), value = 'Synthetic original knowledge remains after a service restart.';
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: datastore });
  try {
    await engine.executeRaw('CREATE TABLE startup_path_retention_probe(id int PRIMARY KEY, body text)');
    await engine.executeRaw('INSERT INTO startup_path_retention_probe VALUES(1,$1)', [value]);
  } finally { await engine.disconnect(); }
  expect(precheckPgliteLock(datastore).blocked).toBe(false);
  const reopened = new PGLiteEngine();
  await reopened.connect({ database_path: datastore });
  try { expect((await reopened.executeRaw<{ body: string }>('SELECT body FROM startup_path_retention_probe WHERE id=1'))[0]?.body).toBe(value); }
  finally { await reopened.disconnect(); }
  expect(readFileSync(path)).toEqual(bytes);
}, 60000);

if (url) test('Postgres 继续使用连接地址，PGLite 同名文件不改变路由或数据库记录', async () => {
  const path = join(root, 'postgres-unused.pglite');
  writeFileSync(path, 'Postgres must not inspect or replace the unused PGLite path.');
  const engine = new PostgresEngine();
  const table = `startup_path_probe_${randomUUID().replaceAll('-', '')}`;
  await engine.connect({ database_url: url, database_path: path });
  try {
    await engine.executeRaw(`CREATE TABLE ${table}(id int PRIMARY KEY, body text)`);
    await engine.executeRaw(`INSERT INTO ${table} VALUES(1,$1)`, ['Retained Postgres record.']);
  } finally { await engine.disconnect(); }
  const reopened = new PostgresEngine();
  await reopened.connect({ database_url: url, database_path: path });
  try { expect((await reopened.executeRaw<{ body: string }>(`SELECT body FROM ${table} WHERE id=1`))[0]?.body).toBe('Retained Postgres record.'); }
  finally { await reopened.executeRaw(`DROP TABLE ${table}`);await reopened.disconnect(); }
  expect(readFileSync(path, 'utf8')).toContain('must not inspect');
}, 60000);
