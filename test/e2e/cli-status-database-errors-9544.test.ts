import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';

const url = requirePostgresTestDatabase();
const root = resolve(mkdtempSync(join(tmpdir(), 'gbrain-status-errors-')));
let pg: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
beforeAll(async () => { pg = await isolatedPersistencePostgres(url); }, 120_000);
afterAll(async () => { await pg?.close(); rmSync(root, { recursive: true, force: true }); });

async function run(args: string[], databaseUrl: string, fixture = false, socket = false) {
  const home = join(root, crypto.randomUUID());
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: databaseUrl }));
  const child = Bun.spawn([process.execPath, fixture ? 'test/fixtures/cli-status-database-error.ts' : 'src/cli.ts', ...args], {
    cwd: resolve(import.meta.dir, '../..'),
    env: keylessBrainEnv(process.env, home, { DATABASE_URL: databaseUrl, GBRAIN_DATABASE_URL: undefined,
      PGHOST: socket ? join(root, 'missing-socket') : undefined,
      GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1', GBRAIN_NO_UPDATE_CHECK: '1', GBRAIN_TELEMETRY: 'off' }),
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

    return { stdout, stderr, code };
  } finally { clearTimeout(timer); }
}

function refused(result: { stdout: string; stderr: string; code: number }) {
  expect(result.code).toBe(1);
  const doc = JSON.parse(result.stdout);
  expect(doc).toMatchObject({ code: 'database_error', retryable: true });
  expect(doc.fix.command).toContain('engine status --probe');
  expect(result.stdout).not.toContain(pg.databaseUrl);
  return doc;
}

for (const command of [['sources', 'writer', 'status'], ['jobs', 'stats']]) {
  test(`${command.join(' ')} missing PostgreSQL socket emits one retryable JSON document`, async () => {
    const missing = `postgres:///${new URL(pg.databaseUrl).pathname.slice(1)}`;
    refused(await run([...command, '--json'], missing, false, true));
    refused(await run([...command, '--brain', 'host', '--json'], missing, false, true));
  }, 90_000);
  test(`${command.join(' ')} interrupted real database read emits one retryable JSON document`, async () => {
    refused(await run([...command, '--json'], pg.databaseUrl, true));
  }, 45_000);
  test(`${command.join(' ')} healthy JSON and human failures keep their contracts`, async () => {
    const healthy = await run([...command, '--json'], pg.databaseUrl);
    expect(healthy.code).toBe(0);
    expect(JSON.parse(healthy.stdout)).not.toHaveProperty('error');
    const failed = await run(command, pg.databaseUrl, true);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).not.toBe('');
  }, 90_000);
}
