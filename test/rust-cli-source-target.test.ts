/**
 * A source the user selected must never fall back to the cross-source view on a Rust brain.
 *
 * The CLI resolves the operation's source before the operation runs (GBRAIN_SOURCE, a registered local_path source
 * holding the cwd, a .gbrain-source dotfile, the sources.default config). The Rust engine used to serve no raw SQL, so that
 * lookup ended in its typed capability refusal, and the CLI had once swallowed it and read every source. The store now serves
 * the source reads (source-scope-reads-recut), so the lookup succeeds and the command runs scoped: a selected source answers
 * for itself only, and one that is not registered ends in the typed `unknown_source` error, never in a read of every source.
 * The probe is `list --json`, which is source-scoped (`stats` counts the whole brain whatever source is selected).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: source isolation of CLI reads on a Rust brain when the user selected a source.
 * 2. Fails when: a selected source reads every source again (a page of another source is listed), including when the source
 *    comes from a registered local_path or a dotfile rather than an explicit selection; or an unknown source stops giving the
 *    typed `unknown_source` error (a capability refusal, exit 0, or a listing of any source).
 * 3. Existing coverage: test/source-resolver*.test.ts covers the tiers on PGLite; the Rust CLI parity suite clears
 *    GBRAIN_SOURCE, so it never selects a source.
 * 4. Seams: none. It runs the real CLI and needs the addon `bun run rust:build` writes; it skips without it
 *    (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 makes a missing addon an error). main gained the capability, so this replaces the
 *    capability-refusal cases master #9946 wrote against a Rust engine that served no source reads.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1') {
  throw new Error(`GBRAIN_TEST_REQUIRE_RUST_ADDON=1 but ${ADDON} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let root: string;
let home: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-rust-source-target-'));
  home = join(root, 'home');
  cwd = join(root, 'cwd');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: join(root, 'db') }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE']) delete base[key];
  const r = spawnSync('bun', ['run', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...base,
      HOME: home,
      GBRAIN_HOME: home,
      GBRAIN_SELF_UPGRADE_MODE: 'off',
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
      GBRAIN_SWEEP: '0',
      GBRAIN_RUST_ENGINE_ADDON: ADDON,
      ...env,
    },
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function refusal(out: { stdout: string; stderr: string }): { code?: string; reason?: string } {
  const text = out.stdout.trim() || out.stderr.trim();
  return JSON.parse(text.slice(text.indexOf('{')));
}

/** Two sources with pages: `work` holds one page, `other` two. `workPath` is the local_path `work` is registered under. */
async function seed(workPath: string): Promise<void> {
  const engine = openRustEngine({ addon: await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON } }), databasePath: join(root, 'db') });
  await engine.connect({ engine: 'pglite', database_path: join(root, 'db') } as never);
  const brain = engine.openStore('test').brain;
  await brain.upsertSource({ id: 'work', name: 'work', local_path: workPath, config: {} });
  await brain.upsertSource({ id: 'other', name: 'other', local_path: join(root, 'other-path'), config: {} });
  const page = (title: string) => ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '' }) as never;
  await engine.putPage('notes/work-1', page('Work 1'), { sourceId: 'work' } as never);
  await engine.putPage('notes/other-1', page('Other 1'), { sourceId: 'other' } as never);
  await engine.putPage('notes/other-2', page('Other 2'), { sourceId: 'other' } as never);
  await engine.disconnect();
}

/** What `list --json` answered: its exit status and the (source, slug) of every page it listed, sorted. */
function listed(r: { status: number; stdout: string }): { status: number; pages: string[] } {
  const rows = r.status === 0 ? JSON.parse(r.stdout) as Array<{ slug: string; source_id: string }> : [];
  return { status: r.status, pages: rows.map((row) => `${row.source_id}:${row.slug}`).sort() };
}

const WORK_ONLY = { status: 0, pages: ['work:notes/work-1'] };
const OTHER_ONLY = { status: 0, pages: ['other:notes/other-1', 'other:notes/other-2'] };

describe('a selected source on a Rust brain', () => {
  withAddon('with no source selected, stats reads the whole brain and list the default source, which holds no page (the control)', async () => {
    await seed(join(root, 'work-path'));
    expect(JSON.parse(run(['stats', '--json']).stdout).page_count).toBe(3);
    expect(listed(run(['list', '--json']))).toEqual({ status: 0, pages: [] });
  }, 90_000);

  withAddon('GBRAIN_SOURCE: the command answers for the selected source only, and an unknown source is the typed source error', async () => {
    await seed(join(root, 'work-path'));
    expect(listed(run(['list', '--json'], { GBRAIN_SOURCE: 'other' }))).toEqual(OTHER_ONLY);
    expect(listed(run(['list', '--json'], { GBRAIN_SOURCE: 'work' }))).toEqual(WORK_ONLY);
    const unknown = run(['list', '--json'], { GBRAIN_SOURCE: 'nope' });
    expect(listed(unknown)).toEqual({ status: 1, pages: [] });
    expect(refusal(unknown)).toMatchObject({ code: 'unknown_source', error: 'unknown_source' });
    expect(unknown.stdout).not.toContain('notes/');
  }, 120_000);

  withAddon('a registered local_path source holding the cwd: the command answers for that source only', async () => {
    await seed(cwd);
    expect(listed(run(['list', '--json']))).toEqual(WORK_ONLY);
    // An explicit selection still beats the registered path.
    expect(listed(run(['list', '--json'], { GBRAIN_SOURCE: 'other' }))).toEqual(OTHER_ONLY);
  }, 120_000);

  withAddon('a .gbrain-source dotfile: the command answers for the named source only, and an unknown name is the typed source error', async () => {
    await seed(join(root, 'work-path'));
    writeFileSync(join(cwd, '.gbrain-source'), 'other\n');
    expect(listed(run(['list', '--json']))).toEqual(OTHER_ONLY);
    writeFileSync(join(cwd, '.gbrain-source'), 'nope\n');
    const unknown = run(['list', '--json']);
    expect(listed(unknown)).toEqual({ status: 1, pages: [] });
    expect(refusal(unknown)).toMatchObject({ code: 'unknown_source' });
    expect(unknown.stdout).not.toContain('notes/');
  }, 120_000);
});
