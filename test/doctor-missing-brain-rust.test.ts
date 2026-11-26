/**
 * `gbrain doctor` on a Rust-engine brain whose store directory is gone (an unmounted drive or a moved folder): the same
 * pre-connect refusal PGLite has had since #9900 (src/commands/doctor/missing-brain.ts), with the same JSON envelope.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: with the Rust store moved away, `gbrain doctor`, `doctor --json` and `doctor --only connection --json`
 *    exit non-zero with the `brain_missing` envelope (reason `missing_brain`, fix actor `user`, no health score), name
 *    the configured store path, and create nothing: the path is still absent and the home tree is unchanged. Once the
 *    store is back, doctor's connection check is ok again. `--fast` still runs and creates nothing.
 *  - Regression: on rust-engine/main a597e7a6c6 the refusal tested only `engine === 'pglite'`, so a Rust doctor
 *    connected, the store's `open_dir` created a new empty store at the configured path, and doctor scored it 75 with
 *    exit 0 (gbrain-evals check health-1).
 *  - Why existing coverage misses it: test/doctor-missing-brain.test.ts configures PGLite only.
 *  - Seam: the real CLI entry in a child process (test/helpers/cli-spawn.ts) with the built addon; the store is made by
 *    `gbrain import` and moved with a rename.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ROOT = join(import.meta.dir, '..');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && (process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' || process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1')) {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

let home: string;
let store: string;
let moved: string;
const env = () => ({ GBRAIN_RUST_ENGINE_ADDON: ADDON, GBRAIN_SWEEP: '0', GBRAIN_SKIP_STARTUP_HOOKS: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });

/** Everything under the gbrain home, so "creates nothing" is checked on the whole tree, not one path. */
function listing(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      out.push(p);
      if (e.isDirectory() && p !== moved) walk(p);
    }
  };
  walk(join(home, '.gbrain'));
  return out.sort();
}

describe.skipIf(!HAVE_ADDON)('doctor refuses a configured Rust brain whose store is not there', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-missing-rust-'));
    store = join(home, '.gbrain', 'brain.rust');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: store }));
    const notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'alpha.md'), '---\ntitle: Alpha\n---\nAlpha body.\n');
    const imported = await runCli(['import', notes, '--no-embed'], { home, env: env(), timeoutMs: 120_000 });
    expect(imported.exitCode).toBe(0);
    expect(existsSync(join(store, 'FORMAT'))).toBe(true);
    moved = `${store}.moved`;
    renameSync(store, moved); // the drive is unmounted / the folder moved
  }, 180_000);

  afterAll(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  for (const [label, args] of [
    ['doctor --json', ['doctor', '--json']],
    ['doctor --only connection --json', ['doctor', '--only', 'connection', '--json']],
  ] as const) {
    test(`${label}: brain_missing, a non-zero exit, and no store created`, async () => {
      const before = listing();
      const r = await runCli([...args], { home, env: env(), timeoutMs: 120_000 });
      expect(r.exitCode).not.toBe(0);
      const out = JSON.parse(r.stdout) as Record<string, any>;
      expect(out.status).not.toBe('healthy');
      expect(out.health_score).toBeUndefined();
      expect(out.code).toBe('brain_missing');
      expect(out.reason).toBe('missing_brain');
      const text = JSON.stringify(out);
      expect(text).toContain(store);
      expect(text).toContain('an unmounted drive or a moved folder?');
      expect(text).toContain('Nothing was created there.');
      expect(out.fix?.actor).toBe('user');
      expect(existsSync(store)).toBe(false);
      expect(listing()).toEqual(before);
    }, 180_000);
  }

  test('plain doctor: the same refusal in text, a non-zero exit, and no store created', async () => {
    const before = listing();
    const r = await runCli(['doctor'], { home, env: env(), timeoutMs: 120_000 });
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('Nothing was created there.');
    expect(existsSync(store)).toBe(false);
    expect(listing()).toEqual(before);
  }, 180_000);

  test('an empty folder where the store was (a bare mount point) is refused the same way and stays empty', async () => {
    mkdirSync(store);
    try {
      const r = await runCli(['doctor', '--only', 'connection', '--json'], { home, env: env(), timeoutMs: 120_000 });
      expect(r.exitCode).not.toBe(0);
      expect((JSON.parse(r.stdout) as { code?: string }).code).toBe('brain_missing');
      expect(readdirSync(store)).toEqual([]);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  }, 180_000);

  test('--fast never connects, so it still runs and creates nothing', async () => {
    const before = listing();
    const fast = await runCli(['doctor', '--fast', '--json'], { home, env: env(), timeoutMs: 120_000 });
    expect(fast.stdout).toContain('"checks"');
    expect(existsSync(store)).toBe(false);
    expect(listing()).toEqual(before);
  }, 180_000);

  test('the moved store is untouched, and doctor connects again once it is back', async () => {
    expect(existsSync(join(moved, 'FORMAT'))).toBe(true);
    renameSync(moved, store);
    try {
      const r = await runCli(['doctor', '--only', 'connection', '--json'], { home, env: env(), timeoutMs: 120_000 });
      const out = JSON.parse(r.stdout) as Record<string, any>;
      expect(out.reason).toBeUndefined();
      expect(out.checks.find((c: { name: string }) => c.name === 'connection')?.status).toBe('ok');
    } finally {
      renameSync(store, moved);
    }
  }, 180_000);
});
