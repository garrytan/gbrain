/**
 * scripts/stress/run.ts against a real PostgreSQL server: every database
 * iteration gets its own fresh database (CREATE DATABASE … TEMPLATE), a
 * gated arm that never connects fails, and owned databases are dropped after
 * the run and after Ctrl-C. Runs where DATABASE_URL names a test server
 * (test/postgres-unit-arms.txt, docs/TESTING.md#stress-gate).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';

const REPO = join(import.meta.dir, '..', '..');
const RUNNER = join(REPO, 'scripts', 'stress', 'run.ts');
const DB = process.env.DATABASE_URL;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-test-stress-pg-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); }
  return root;
}
const runnerEnv = (root: string, extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_STRESS_ROOT: root, GBRAIN_STRESS_ADMIN_URL: DB, ...extra };
  delete env.DATABASE_URL;
  return env;
};
async function stressDatabases(tag: string): Promise<string[]> {
  const sql = postgres(DB!, { max: 1, onnotice: () => {} });
  try { return (await sql`SELECT datname FROM pg_database WHERE datname LIKE ${`gbrain_stress_${tag}%`}`).map(r => String(r.datname)); } finally { await sql.end({ timeout: 5 }); }
}
const connect = `import postgres from ${JSON.stringify(join(REPO, 'vendor/postgres/src/index.js'))};\nimport { appendFileSync } from 'node:fs';\n`;

describe.skipIf(!DB)('test:stress with a database', () => {
  test('each database iteration gets a fresh database, and every one is dropped afterwards', async () => {
    const root = tree({ 'test/arm.test.ts': `${connect}import { test, expect } from 'bun:test';\ntest.skipIf(!process.env.DATABASE_URL)('postgres arm', async () => {\n  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });\n  const [{ db }] = await sql\`SELECT current_database() AS db\`;\n  await sql\`CREATE TABLE leftover (id int)\`;\n  await sql.end();\n  appendFileSync(process.env.STRESS_FIXTURE_LOG!, db + '\\n');\n  expect(db).toMatch(/^gbrain_stress_.*_test$/);\n});\n` });
    const log = join(root, 'dbs.txt');
    const r = spawnSync(process.execPath, [RUNNER, 'test/arm.test.ts', '--postgres', '--iterations', '3', '--out', join(root, 'out')], { encoding: 'utf8', env: runnerEnv(root, { STRESS_FIXTURE_LOG: log }), timeout: 180_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const names = readFileSync(log, 'utf8').trim().split('\n');
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    const manifest = JSON.parse(readFileSync(join(root, 'out', 'stress-manifest.json'), 'utf8'));
    expect(manifest.files[0]).toMatchObject({ profile: 'postgres-arm', env: 'database', arm: 'pglite+postgres', status: 'pass' });
    for (const it of manifest.files[0].iterations) expect(it.databaseActivity).toBeGreaterThan(0);
    const tag = /^gbrain_stress_(\d+_[0-9a-f]+)_i\d+_test$/.exec(names[0]!)![1]!;
    expect(await stressDatabases(tag)).toEqual([]);
    expect(readdirSync(join(root, '.context', 'test-stress', 'owned'))).toEqual([]);
  }, 200_000);

  test('a gated arm that never reaches its database fails the iteration', () => {
    const root = tree({ 'test/silent.test.ts': "import { test } from 'bun:test';\ntest.skipIf(!process.env.DATABASE_URL)('claims a postgres arm', () => {});\n" });
    const r = spawnSync(process.execPath, [RUNNER, 'test/silent.test.ts', '--postgres', '--iterations', '1', '--out', join(root, 'out')], { encoding: 'utf8', env: runnerEnv(root), timeout: 120_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stdout).toContain('the PostgreSQL arm never connected');
  }, 150_000);

  test('Ctrl-C stops the running file and drops every database the run created', async () => {
    const root = tree({ 'test/slow.test.ts': `${connect}import { test } from 'bun:test';\ntest.skipIf(!process.env.DATABASE_URL)('holds', async () => {\n  appendFileSync(process.env.STRESS_FIXTURE_LOG!, 'started\\n');\n  await new Promise(r => setTimeout(r, 60_000));\n}, 120_000);\n` });
    const log = join(root, 'started.txt');
    const child = spawn(process.execPath, [RUNNER, 'test/slow.test.ts', '--postgres', '--iterations', '1', '--out', join(root, 'out')], { env: runnerEnv(root, { STRESS_FIXTURE_LOG: log }), stdio: 'ignore' });
    const exited = new Promise<number | null>(res => child.on('exit', code => res(code)));
    const deadline = Date.now() + 60_000;
    while (!existsSync(log) && Date.now() < deadline) await Bun.sleep(100);
    expect(existsSync(log)).toBe(true);
    const owned = join(root, '.context', 'test-stress', 'owned');
    const record = JSON.parse(readFileSync(join(owned, readdirSync(owned)[0]!), 'utf8')) as { databases: string[] };
    expect(record.databases.length).toBe(2);
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    const tag = /^gbrain_stress_(\d+_[0-9a-f]+)_/.exec(record.databases[0]!)![1]!;
    expect(await stressDatabases(tag)).toEqual([]);
    expect(readdirSync(owned)).toEqual([]);
  }, 120_000);
});
