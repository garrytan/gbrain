/**
 * A source the user selected must never fall back to the cross-source view on a Rust brain.
 *
 * The CLI resolves the operation's source before the operation runs (GBRAIN_SOURCE, a .gbrain-source dotfile, the
 * sources.default config). The Rust engine serves no raw SQL, so that lookup ends in its typed capability refusal.
 * The CLI used to swallow every ambient-tier failure and leave the source unset, which reads every source: a user who
 * asked for one source got answers from all of them. The refusal now stops the command instead.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: source isolation of CLI reads on a Rust brain when the user selected a source.
 * 2. Fails when: makeContext swallows the capability refusal again and the read runs unscoped (exit 0), including when
 *    the source comes from a registered local_path rather than an explicit selection.
 * 3. Existing coverage: test/source-resolver*.test.ts covers the tiers on PGLite, where the lookup succeeds; the Rust
 *    CLI parity suite clears GBRAIN_SOURCE, so it never selects a source.
 * 4. Seams: none. It runs the real CLI and needs the addon `bun run rust:build` writes; it skips without it
 *    (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 makes a missing addon an error).
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

describe('a selected source on a Rust brain', () => {
  withAddon('with no source selected, stats reads the brain (exit 0)', () => {
    const r = run(['stats', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).page_count).toBe(0);
  }, 60_000);

  withAddon('GBRAIN_SOURCE: the command refuses with the typed capability refusal instead of reading every source', () => {
    const r = run(['stats', '--json'], { GBRAIN_SOURCE: 'other' });
    expect(r.status).not.toBe(0);
    expect(refusal(r)).toMatchObject({ code: 'engine_capability_missing' });
  }, 60_000);

  withAddon('a registered local_path source holding the cwd: the command refuses instead of reading every source', async () => {
    // Seed the source in process (the CLI cannot add one on Rust yet), then close the store for the CLI.
    const engine = openRustEngine({ addon: await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON } }), databasePath: join(root, 'db') });
    await engine.connect({ engine: 'pglite', database_path: join(root, 'db') } as never);
    await engine.openStore('test').brain.upsertSource({ id: 'work', name: 'work', local_path: cwd, config: {} });
    await engine.disconnect();
    const r = run(['stats', '--json']);
    expect(r.status).not.toBe(0);
    expect(refusal(r)).toMatchObject({ code: 'engine_capability_missing' });
  }, 60_000);

  withAddon('a .gbrain-source dotfile: the command refuses instead of reading every source', () => {
    writeFileSync(join(cwd, '.gbrain-source'), 'other\n');
    const r = run(['stats', '--json']);
    expect(r.status).not.toBe(0);
    expect(refusal(r)).toMatchObject({ code: 'engine_capability_missing' });
  }, 60_000);
});
