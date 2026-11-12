/**
 * #9191: `apply-migrations --force-schema` on the lease path must replay the
 * schema blob, so a blob-owned table that went missing is recreated.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { collect, makeHome, spawnDriver } from './helpers/apply-migrations-lock-driver.ts';
import { writeSchemaDriver } from './helpers/apply-migrations-schema-driver.ts';

const REPO = resolve(import.meta.dir, '..');
const work = mkdtempSync(join(tmpdir(), 'gbrain-force-schema-9191-'));
const TEMPLATE = join(work, 'template.pglite');
const homes: string[] = [];
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_path: TEMPLATE });
  await engine.initSchema();
  await engine.executeRaw('DROP TABLE oauth_tokens');
  await engine.disconnect();
}, 180_000);

afterAll(async () => {
  await engine.disconnect();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function tableExists(datastore: string): string {
  const script = `const { PGLiteEngine } = await import(${JSON.stringify(join(REPO, 'src/core/pglite-engine.ts'))});
const e = new PGLiteEngine(); await e.connect({ database_path: ${JSON.stringify(datastore)} });
const r = await e.executeRaw("SELECT to_regclass('public.oauth_tokens') AS t"); console.log('T=' + r[0].t); await e.disconnect();`;
  const r = spawnSync(process.execPath, ['--no-env-file', '-e', script], { encoding: 'utf8', timeout: 120_000 });
  return r.stdout.trim().split('\n').pop() ?? '';
}

describe('apply-migrations --force-schema (#9191)', () => {
  test('replays the schema blob so a missing blob-owned table is recreated', async () => {
    const home = makeHome({ engine: 'pglite' });
    homes.push(home);
    const datastore = join(home, 'brain.pglite');
    cpSync(TEMPLATE, datastore, { recursive: true });
    expect(tableExists(datastore)).toBe('T=null');
    const driver = writeSchemaDriver(home, { migrations: ['noop'], args: ['--force-schema', '--yes', '--non-interactive', '--no-autopilot-install'] });
    const r = await collect(spawnDriver(home, driver));
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(tableExists(datastore)).toBe('T=oauth_tokens');
  }, 180_000);
});
