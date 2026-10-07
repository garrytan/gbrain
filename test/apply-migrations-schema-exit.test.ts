/**
 * #6089 exit matrix off Postgres. PGLite keeps skipping the pre-flight (#1100)
 * and checks the schema version in-process after the orchestrators released
 * the datastore; an unreachable Postgres stays non-fatal (apply-migrations,
 * in-process `gbrain post-upgrade`, package postinstall) and says so with the
 * GBRAIN_DB_ACCESS marker. The Postgres cases live in
 * test/e2e/apply-migrations-schema-exit.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { collect, makeHome, spawnDriver } from './helpers/apply-migrations-lock-driver.ts';
import { parseDocument, writeSchemaDriver, type SchemaDriverOpts } from './helpers/apply-migrations-schema-driver.ts';

const REPO = resolve(import.meta.dir, '..');
const UNREACHABLE = { engine: 'postgres' as const, database_url: 'postgresql://postgres:postgres@127.0.0.1:1/gbrain_unreachable_6089' };
const work = mkdtempSync(join(tmpdir(), 'gbrain-schema-exit-'));
const AT_HEAD = join(work, 'at-head.pglite');
const BEHIND = join(work, 'behind.pglite');
const homes: string[] = [];

let engine: PGLiteEngine;
let behindEngine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_path: AT_HEAD });
  await engine.initSchema();
  await engine.disconnect();
  cpSync(AT_HEAD, BEHIND, { recursive: true });
  behindEngine = new PGLiteEngine();
  await behindEngine.connect({ database_path: BEHIND });
  await behindEngine.setConfig('version', String(LATEST_VERSION - 1));
  await behindEngine.disconnect();
}, 180_000);

afterAll(async () => {
  await engine.disconnect();
  await behindEngine.disconnect();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function pgliteHome(template: string): { home: string; datastore: string } {
  const home = makeHome({ engine: 'pglite' });
  homes.push(home);
  const datastore = join(home, 'brain.pglite');
  cpSync(template, datastore, { recursive: true });
  return { home, datastore };
}

function postgresHome(): string {
  const home = makeHome(UNREACHABLE);
  homes.push(home);
  return home;
}

async function run(home: string, opts: SchemaDriverOpts) {
  const result = await collect(spawnDriver(home, writeSchemaDriver(home, opts)));
  const logPath = join(home, 'orchestrator.log');
  return { ...result, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '', out: result.stderr + result.stdout };
}

function readPgliteVersion(datastore: string): number {
  const script = `const { PGLiteEngine } = await import(${JSON.stringify(join(REPO, 'src/core/pglite-engine.ts'))});
const e = new PGLiteEngine(); await e.connect({ database_path: ${JSON.stringify(datastore)} });
console.log(await e.getConfig('version')); await e.disconnect();`;
  const r = spawnSync(process.execPath, ['--no-env-file', '-e', script], { encoding: 'utf8', timeout: 120_000 });
  return Number(r.stdout.trim().split('\n').pop());
}

describe('apply-migrations schema check on PGLite (#6089)', () => {
  test('schema behind, --yes: checked after the orchestrators and brought to head in-process, exit 0', async () => {
    const { home, datastore } = pgliteHome(BEHIND);
    const r = await run(home, { migrations: ['reconcile'], args: ['--yes', '--non-interactive', '--no-autopilot-install'] });
    expect(r.code, r.out).toBe(0);
    expect(r.log).toBe('ran reconcile\n');
    expect(readPgliteVersion(datastore)).toBe(LATEST_VERSION);
  }, 180_000);

  test('schema behind, no --yes: exit 1 migrations_pending not_applied, the datastore is left as it was', async () => {
    const { home, datastore } = pgliteHome(BEHIND);
    const r = await run(home, { migrations: ['reconcile'], args: ['--json', '--no-autopilot-install'] });
    expect(r.code, r.out).toBe(1);
    const doc = parseDocument(r.stdout);
    expect(doc.code).toBe('migrations_pending');
    expect(doc.reason).toBe('not_applied');
    expect(doc.schema_pending).toMatchObject({ current: LATEST_VERSION - 1, latest: LATEST_VERSION, pending: [LATEST_VERSION] });
    expect(doc.fix.argv).toContain('--yes');
    expect(readPgliteVersion(datastore)).toBe(LATEST_VERSION - 1);
  }, 180_000);

  test('schema at head: exit 0', async () => {
    const { home } = pgliteHome(AT_HEAD);
    const r = await run(home, { migrations: ['reconcile', 'noop'], args: ['--no-autopilot-install'] });
    expect(r.code, r.out).toBe(0);
    expect(r.log).toBe('ran reconcile\nran noop\n');
  }, 180_000);
});

describe('apply-migrations with Postgres unreachable stays non-fatal and says so (#6089)', () => {
  test('apply-migrations --yes: filesystem-only orchestrators run, exit 0, GBRAIN_DB_ACCESS marker', async () => {
    const home = postgresHome();
    const r = await run(home, { migrations: ['noop'], args: ['--yes', '--non-interactive', '--json'] });
    expect(r.code, r.out).toBe(0);
    expect(r.log).toBe('ran noop\n');
    expect(r.stderr).toMatch(/^GBRAIN_DB_ACCESS \w+$/m);
    expect(r.stderr).toContain('schema version was not checked');
    expect(parseDocument(r.stdout).database.status).toBe('unreachable');
  }, 120_000);

  test('--require-db keeps failing hard', async () => {
    const home = postgresHome();
    const r = await run(home, { migrations: ['noop'], args: ['--yes', '--non-interactive', '--require-db'] });
    expect(r.code, r.out).toBe(1);
    expect(r.log).toBe('');
  }, 120_000);

  test('gbrain post-upgrade (in-process apply-migrations) is not failed by it', async () => {
    const home = postgresHome();
    const r = await run(home, { migrations: ['noop'], args: ['--json', '--no-autopilot-install'], entry: 'post-upgrade' });
    expect(r.code, r.out).toBe(0);
    expect(r.log).toBe('ran noop\n');
    expect(r.stderr).toMatch(/^GBRAIN_DB_ACCESS \w+$/m);
    expect(parseDocument(r.stdout).apply_migrations).toEqual({ exit_code: 0 });
  }, 180_000);

  test('package postinstall runs apply-migrations, which exits 0, so no recovery hint is printed', async () => {
    const home = postgresHome();
    const driver = writeSchemaDriver(home, { migrations: ['noop'], args: [], entry: 'argv' });
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(driver)} "$@"\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, ['--no-env-file', join(REPO, 'scripts/postinstall.ts')], {
      cwd: home,
      env: { HOME: home, GBRAIN_HOME: home, PATH: `${bin}:/usr/bin:/bin`, GBRAIN_SKIP_REFERENCE_SWEEP: '1' },
      encoding: 'utf8', timeout: 120_000,
    });
    const out = r.stdout + r.stderr;
    expect(r.status, out).toBe(0);
    expect(readFileSync(join(home, 'orchestrator.log'), 'utf8')).toBe('ran noop\n');
    expect(r.stderr).toMatch(/^GBRAIN_DB_ACCESS \w+$/m);
    expect(out).not.toContain('postinstall skipped');
  }, 120_000);
});
