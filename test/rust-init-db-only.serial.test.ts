/**
 * `gbrain init --rust`: a database-only Rust brain, set up exactly as `gbrain init --pglite --db-only` (and
 * `gbrain init --url <db> --db-only` on Postgres) set up theirs.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: the one CLI command that creates a Rust brain. Its --json receipt equals the database-only PGLite and
 *    Postgres receipts except the engine, the store path and the ids no two brains share; its database-only content
 *    receipt is stored; `sources list --json` on the new brain equals the others'; and --content-root or --git with
 *    --rust is refused by name (managed content roots are not served on the Rust engine yet), with no brain created.
 * 2. Fails when: --rust is unknown, sets up a different brain, half sets up a content root, or accepts a flag it cannot
 *    honour.
 * 3. Existing coverage: none; before this a Rust brain was made by hand (config.json, then `init --migrate-only`),
 *    which skips the content setup every other init runs.
 * 4. Seams: none. Real CLI, one child process per command, fresh homes. The Rust arm needs the addon
 *    `bun run rust:build` writes and skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error); the
 *    Postgres arm runs with DATABASE_URL, in a scratch database it drops.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = (TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '');
const HAVE_ADDON = !!ADDON && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 and the Rust addon ${ADDON} does not exist; run bun run rust:build`);
const DATABASE_URL = process.env.DATABASE_URL;

const scratch = mkdtempSync(join(tmpdir(), 'gbrain-rust-init-'));
const drops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const drop of drops) await drop();
  rmSync(scratch, { recursive: true, force: true });
});

function gbrain(home: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, GBRAIN_HOME: '' };
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  if (HAVE_ADDON) env.GBRAIN_RUST_ENGINE_ADDON = ADDON;
  const run = Bun.spawnSync(['bun', '--no-env-file', CLI, ...args], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
  return { code: run.exitCode ?? -1, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** The receipt with what no two brains share replaced: the engine, the store path or URL, and the ids. */
function normalised(json: string, home: string): unknown {
  const value = JSON.parse(json) as Record<string, unknown>;
  const text = JSON.stringify({ ...value, engine: '<engine>', ...(value.path ? { path: '<store>' } : {}) }).split(home).join('<home>').replace(UUID, '<uuid>');
  return JSON.parse(text);
}

async function scratchPostgres(): Promise<string> {
  assertSafeE2eDatabaseUrl(DATABASE_URL!);
  const database = `gbrain_test_rust_init_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(DATABASE_URL!, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  drops.push(async () => { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); });
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${database}`;
  return url.toString();
}

describe('gbrain init --rust is the database-only init on the Rust engine', () => {
  const homes: Record<string, string> = {};
  const receipts: Record<string, unknown> = {};
  const lists: Record<string, unknown> = {};

  test('pglite --db-only (the reference)', () => {
    const home = homes.pglite = mkdtempSync(join(scratch, 'pglite-'));
    const out = gbrain(home, ['init', '--pglite', '--db-only', '--json']);
    expect({ code: out.code, stderr: out.code === 0 ? '' : out.stderr }).toEqual({ code: 0, stderr: '' });
    receipts.pglite = normalised(out.stdout, home);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'success', engine: 'pglite', content: { repository_kind: 'db_only', root: null } });
    lists.pglite = JSON.parse(gbrain(home, ['sources', 'list', '--json']).stdout);
  }, 120_000);

  test.skipIf(!DATABASE_URL)('postgres --db-only equals the reference', async () => {
    const home = homes.postgres = mkdtempSync(join(scratch, 'postgres-'));
    const url = await scratchPostgres();
    const out = gbrain(home, ['init', '--url', url, '--db-only', '--non-interactive', '--json']);
    expect({ code: out.code, stderr: out.code === 0 ? '' : out.stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'success', engine: 'postgres', content: { repository_kind: 'db_only', root: null } });
    const { path: _none, ...reference } = receipts.pglite as Record<string, unknown>;
    expect(normalised(out.stdout, home)).toEqual(reference);
  }, 120_000);

  test.skipIf(!HAVE_ADDON)('rust: the same receipt and sources, the engine and store path aside', () => {
    const home = homes.rust = mkdtempSync(join(scratch, 'rust-'));
    const out = gbrain(home, ['init', '--rust', '--json']);
    expect({ code: out.code, stderr: out.code === 0 ? '' : out.stderr }).toEqual({ code: 0, stderr: '' });
    const raw = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(raw).toMatchObject({ status: 'success', engine: 'rust', path: join(home, '.gbrain', 'brain.rust'), content: { repository_kind: 'db_only', root: null } });
    expect(normalised(out.stdout, home)).toEqual(receipts.pglite);
    const list = gbrain(home, ['sources', 'list', '--json']);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual(lists.pglite);
    // The same command again keeps the brain: a second init is the same database-only receipt.
    const again = gbrain(home, ['init', '--rust', '--json']);
    expect(again.code).toBe(0);
    expect(normalised(again.stdout, home)).toEqual(normalised(gbrain(homes.pglite, ['init', '--pglite', '--db-only', '--json']).stdout, homes.pglite));
  }, 120_000);

  test('rust with --content-root or --git is refused by name, and no brain is created', () => {
    for (const flags of [['--content-root', join(scratch, 'root')], ['--git']]) {
      const home = mkdtempSync(join(scratch, 'refused-'));
      const out = gbrain(home, ['init', '--rust', ...flags, '--json']);
      expect(out.code).not.toBe(0);
      expect(JSON.parse(out.stdout)).toMatchObject({ status: 'error', reason: 'invalid_flag', code: 'invalid_params',
        message: expect.stringContaining('--rust sets up a database-only brain') });
      expect(existsSync(join(home, '.gbrain', 'brain.rust'))).toBe(false);
      expect(existsSync(join(scratch, 'root'))).toBe(false);
    }
  }, 120_000);
});
