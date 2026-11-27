/**
 * `gbrain put` of one page on a brain with no managed persistence, through the real CLI, on every engine arm.
 *
 * Every CLI write registers the CLI's local writer first (persistence/identity.ts registerLocalWriter), then admits,
 * journals and publishes the page, then runs post-write housekeeping; `get` reads the page snapshot. On the Rust engine
 * each step needs a served store member. Part B serves the local-writer members; part E serves the rest of the path
 * (docs/research/rust-put-get-member-trace.md). Until E is complete the Rust arm stops with engine_capability_missing,
 * so no release built from master can write a page to a Rust brain through `gbrain put`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: a CLI page write on a Rust brain gives the answer PGLite (and Postgres, with DATABASE_URL) gives, and
 *    stores the same page.
 * 2. Fails when: the Rust arm's put or the read after it exits non-zero (a typed refusal included), or its JSON answer
 *    or the stored page differ from PGLite's once ids and timestamps are left out.
 * 3. Existing coverage: test/rust-cli-parity.serial.test.ts runs only read commands on the Rust brain, and its import
 *    setup records a refusal as an outcome; the engine-parity put cases call engine.putPage, not the operation's
 *    writer registration.
 * 4. Seams: none. It runs the real CLI. The Rust arm needs the addon `bun run rust:build` writes and skips without it
 *    (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 makes a missing addon an error); the Postgres arm runs with DATABASE_URL.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1') {
  throw new Error(`GBRAIN_TEST_REQUIRE_RUST_ADDON=1 but ${ADDON} does not exist; run bun run rust:build`);
}
const DATABASE_URL = process.env.DATABASE_URL;

type Arm = 'pglite' | 'postgres' | 'rust';
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** One brain per arm, each with its own home (so its own local writer credential file) and an empty cwd. */
function brain(arm: Arm): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), `gbrain-rust-cli-put-${arm}-`));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(cwd);
  const config = arm === 'postgres' ? { engine: 'postgres', database_url: DATABASE_URL } : { engine: arm, database_path: join(root, 'db') };
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
  return { home, cwd };
}

function run(at: { home: string; cwd: string }, args: string[]): { status: number; stdout: string; stderr: string } {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE']) delete base[key];
  const r = spawnSync(process.execPath, ['--no-env-file', CLI, ...args], {
    cwd: at.cwd,
    encoding: 'utf8',
    env: {
      ...base,
      HOME: at.home,
      GBRAIN_HOME: at.home,
      GBRAIN_SELF_UPGRADE_MODE: 'off',
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
      GBRAIN_SWEEP: '0',
      GBRAIN_RUST_ENGINE_ADDON: ADDON,
    },
    timeout: 120_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})/g;
/** The answer without ids, timestamps and this run's slug token, which differ between brains and runs. */
function comparable(stdout: string, token: string): unknown {
  return JSON.parse(stdout.split(token).join('TOKEN').replace(UUID, '<uuid>').replace(TIME, '<time>'));
}

/** Puts one page, then reads it back; both through the CLI with --json. */
function putThenGet(arm: Arm, token: string): { put: unknown; get: unknown } {
  const at = brain(arm);
  const slug = `notes/put-parity-${token}`;
  const content = `---\ntype: note\ntitle: Put parity\ntags: [probe]\n---\n# Put parity\n\nOne page written by gbrain put on a brain with no managed persistence.\n`;
  const put = run(at, ['put', slug, '--content', content, '--json']);
  if (put.status !== 0) throw new Error(`${arm} put exited ${put.status}: ${put.stdout.trim() || put.stderr.trim().slice(-2000)}`);
  const get = run(at, ['get', slug, '--json']);
  if (get.status !== 0) throw new Error(`${arm} get exited ${get.status}: ${get.stdout.trim() || get.stderr.trim().slice(-2000)}`);
  return { put: comparable(put.stdout, token), get: comparable(get.stdout, token) };
}

describe('gbrain put on a brain with no managed persistence', () => {
  const token = randomUUID().slice(0, 8);
  let pglite: { put: unknown; get: unknown };

  test('PGLite: the put commits and the page reads back', () => {
    pglite = putThenGet('pglite', token);
    expect(pglite.put).toMatchObject({ slug: 'notes/put-parity-TOKEN', state: 'committed', status: 'created_or_updated', persistence: { mode: 'database' } });
    expect(pglite.get).toMatchObject({ slug: 'notes/put-parity-TOKEN', title: 'Put parity' });
  }, 180_000);

  test.skipIf(!DATABASE_URL)('Postgres: the same answer and the same stored page as PGLite', () => {
    expect(putThenGet('postgres', token)).toEqual(pglite);
  }, 180_000);

  test.skipIf(!HAVE_ADDON)('Rust: the same answer and the same stored page as PGLite', () => {
    expect(putThenGet('rust', token)).toEqual(pglite);
  }, 180_000);
});
