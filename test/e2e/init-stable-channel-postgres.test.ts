/**
 * GBRA-346, Postgres side of test/init-stable-channel.test.ts: a fresh
 * `gbrain init --url` on an empty content database persists
 * `self_upgrade.channel: stable`, and a re-init of a brain whose config never
 * chose a channel leaves it unset.
 *
 * Runs against a scratch database created from DATABASE_URL so the shared E2E
 * database's content cannot make the install look non-fresh.
 *
 * Run: DATABASE_URL=... bun test test/e2e/init-stable-channel-postgres.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
const REPO_ROOT = join(import.meta.dir, '..', '..');

function runInit(gbrainHome: string, url: string): { exitCode: number; stderr: string } {
  const r = Bun.spawnSync(['bun', 'run', join(REPO_ROOT, 'src', 'cli.ts'), 'init', '--url', url, '--non-interactive', '--no-embedding', '--json'], {
    env: { PATH: process.env.PATH, HOME: gbrainHome, GBRAIN_HOME: gbrainHome },
    cwd: gbrainHome,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  return { exitCode: r.exitCode ?? -1, stderr: r.stderr.toString() };
}

describeE2E('init on Postgres: release channel for new installs (GBRA-346)', () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let scratchName = '';
  let scratchUrl = '';
  let home = '';
  const configFile = () => join(home, '.gbrain', 'config.json');

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    scratchName = `gbrain_test_init_channel_${randomUUID().replaceAll('-', '')}`;
    admin = postgres(DATABASE_URL!, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${scratchName}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${scratchName}`;
    scratchUrl = url.toString();
    home = mkdtempSync(join(tmpdir(), 'gbrain-init-channel-pg-'));
  }, 60_000);

  afterAll(async () => {
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
      await admin.end();
    }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('a fresh install persists self_upgrade.channel = stable', () => {
    const r = runInit(home, scratchUrl);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), 'utf-8')).self_upgrade).toMatchObject({ mode: 'notify', mode_prompted: true, channel: 'stable' });
  }, 180_000);

  test('re-init of an existing brain that never chose a channel leaves the channel unset', () => {
    const cfg = JSON.parse(readFileSync(configFile(), 'utf-8'));
    delete cfg.self_upgrade.channel;
    writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
    const r = runInit(home, scratchUrl);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), 'utf-8')).self_upgrade.channel).toBeUndefined();
  }, 180_000);
});
