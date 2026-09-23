import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { persistenceHome } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

const run = process.env.DATABASE_URL ? test : test.skip;
let engine: PostgresEngine;
let close: (() => Promise<void>) | undefined;
let home: string;
let root: string;
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  home = mkdtempSync(join(tmpdir(), 'gbrain-admin-intent-pg-'));
  root = join(home, 'canonical'); mkdirSync(root);
  const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
  engine = isolated.engine; close = isolated.close;
  const [database] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(process.env.DATABASE_URL); url.pathname = `/${database.name}`;
  mkdirSync(join(home, '.gbrain'));
  mkdirSync(join(home, 'skills'));
  writeFileSync(join(home, 'skills', 'RESOLVER.md'), '# Generic fixture skills\n');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: url.toString(), embedding_disabled: true }));
  await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
}, 60_000);
afterAll(async () => {
  if (engine) await disposePersistenceConsumer(engine);
  await close?.();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../src/cli.ts'), ...args], {
    cwd: home, env: { ...process.env, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0',
      GBRAIN_SKILLS_DIR: join(home, 'skills') }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

run('real PostgreSQL hint, routine diagnosis, deliberate noninteractive administration and stale replay', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const initial = await writerAdminState(engine);
    const inspected = await cli(['sources', 'writer', 'status', '--json']);
    expect({ code: inspected.code, stderr: inspected.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(inspected.stdout)).toMatchObject({ enabled: false, host_id: null, admin_state: initial });
    expect(existsSync(join(persistenceHome(), 'host.json'))).toBe(false);
    const freshDiagnosis = await cli(['doctor', '--fast', '--json']);
    expect([0, 1]).toContain(freshDiagnosis.code);
    expect(JSON.parse(freshDiagnosis.stdout)).toHaveProperty('checks');
    expect(existsSync(join(persistenceHome(), 'host.json'))).toBe(false);
    expect(await writerAdminState(engine)).toBe(initial);
    await expect(submitPageMutation({ engine, config: { engine: 'postgres', embedding_disabled: true }, remote: false, dryRun: false,
      sourceId: 'default', logger: { info() {}, warn() {}, error() {} } }, {
      operation: 'put_page', params: { slug: 'notes/example', content: '# Generic example' }, waitMs: 0,
    })).rejects.toMatchObject({ code: 'owner_unavailable', suggestion: expect.stringContaining('Inspect gbrain sources writer status --json') });
    const identity = readFileSync(join(persistenceHome(), 'host.json'), 'utf8');
    for (const args of [['doctor', '--fast', '--json'], ['doctor', '--fast', '--fix', '--skills-dir', join(home, 'skills'), '--json']]) {
      const result = await cli(args);
      expect([0, 1]).toContain(result.code);
      expect(JSON.parse(result.stdout)).toHaveProperty('checks');
      expect(await writerAdminState(engine)).toBe(initial);
      expect(readFileSync(join(persistenceHome(), 'host.json'), 'utf8')).toBe(identity);
    }
    for (const args of [
      ['claim', 'default', '--path', root],
      ['activate', '--confirm-quiesced'],
      ['transfer', 'prepare', 'default'],
    ]) {
      const refusal = await cli(['sources', 'writer', ...args, '--json']);
      expect(refusal.code).toBe(1);
      expect(JSON.parse(refusal.stdout)).toMatchObject({ error: 'writer_admin_intent_required' });
      expect(await writerAdminState(engine)).toBe(initial);
    }
    const claimed = await cli(['sources', 'writer', 'claim', 'default', '--path', root, '--admin-intent', 'writer_claim', '--expected-state', initial, '--json']);
    expect({ code: claimed.code, stderr: claimed.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(claimed.stdout)).toMatchObject({ claimed: true });
    const stale = await cli(['sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', initial, '--json']);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({ error: 'writer_admin_state_changed' });
    const status = JSON.parse((await cli(['sources', 'writer', 'status', '--json'])).stdout);
    const activated = await cli(['sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', 'writer_activate', '--expected-state', status.admin_state, '--json']);
    expect({ code: activated.code, stderr: activated.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(activated.stdout)).toMatchObject({ enabled: true, activated: true });
    expect(readFileSync(join(persistenceHome(), 'host.json'), 'utf8')).toBe(identity);
  });
}, 120_000);
