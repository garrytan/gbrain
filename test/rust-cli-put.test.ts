/**
 * `gbrain put` and `gbrain get` of pages on a brain with no managed persistence, through the real CLI, on every engine arm.
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
/**
 * The answer without the values that differ between brains and runs: uuids (request ids, revisions), timestamps, this
 * run's slug token, and the numeric row ids (`id`, `page_id`), since the Postgres arm writes into a shared test
 * database whose sequences earlier runs advanced.
 */
function comparable(stdout: string, token: string): unknown {
  return JSON.parse(stdout.split(token).join('TOKEN').replace(UUID, '<uuid>').replace(TIME, '<time>'),
    (key, value) => (key === 'id' || key === 'page_id') && typeof value === 'number' ? '<id>' : value);
}

type Outcome = { puts: unknown[]; gets: unknown[]; stored: string[] };

/**
 * Puts two pages, then rewrites the first, all through the CLI with --json; then reads both back, as JSON and as the
 * stored markdown `gbrain get` prints.
 */
function putThenGet(arm: Arm, token: string): Outcome {
  const at = brain(arm);
  const first = `notes/put-parity-${token}`;
  const second = `notes/put-parity-${token}-two`;
  const page = (title: string, line: string) => `---\ntype: note\ntitle: ${title}\ntags: [probe]\n---\n# ${title}\n\n${line}\n`;
  const step = (args: string[]) => {
    const r = run(at, args);
    if (r.status !== 0) throw new Error(`${arm} ${args.slice(0, 2).join(' ')} exited ${r.status}: ${r.stdout.trim() || r.stderr.trim().slice(-2000)}`);
    return r.stdout;
  };
  const put = (slug: string, content: string, extra: string[] = []) => step(['put', slug, '--content', content, ...extra, '--json']);
  const created = put(first, page('Put parity', 'One page written by gbrain put on a brain with no managed persistence.'));
  const revision = String((JSON.parse(created) as { revision: string }).revision);
  const outputs = [
    created,
    put(second, page('Second page', 'A second page, so the write path runs on a brain that already holds a page.')),
    // The first page again, so an update of a stored page (with the revision the create returned) runs too.
    put(first, page('Put parity', 'The first page again, rewritten.'), ['--expected-revision', revision]),
  ];
  const puts = outputs.map(stdout => comparable(stdout, token));
  const gets = [first, second].map(slug => comparable(step(['get', slug, '--json']), token));
  const stored = [first, second].map(slug => step(['get', slug]).split(token).join('TOKEN'));
  return { puts, gets, stored };
}

describe('gbrain put on a brain with no managed persistence', () => {
  const token = randomUUID().slice(0, 8);
  let pglite: Outcome;

  test('PGLite: the puts commit and the pages read back', () => {
    pglite = putThenGet('pglite', token);
    for (const put of pglite.puts) expect(put).toMatchObject({ state: 'committed', status: 'created_or_updated', persistence: { mode: 'database' } });
    expect(pglite.gets[0]).toMatchObject({ slug: 'notes/put-parity-TOKEN', title: 'Put parity' });
    expect(pglite.gets[1]).toMatchObject({ slug: 'notes/put-parity-TOKEN-two', title: 'Second page' });
    expect(pglite.stored[0]).toContain('The first page again, rewritten.');
  }, 240_000);

  test.skipIf(!DATABASE_URL)('Postgres: the same answers and the same stored pages as PGLite', () => {
    expect(putThenGet('postgres', token)).toEqual(pglite);
  }, 240_000);

  test.skipIf(!HAVE_ADDON)('Rust: the same answers and the same stored pages as PGLite', () => {
    expect(putThenGet('rust', token)).toEqual(pglite);
  }, 240_000);
});
