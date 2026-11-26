/**
 * Read commands on a Rust-engine brain whose store directory is gone (an unmounted drive or a moved folder) refuse with
 * doctor's `brain_missing` envelope and create nothing (src/core/engine-connect.ts, src/commands/doctor/missing-brain.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: with the Rust store moved away, or an empty folder in its place, `status`, `get`, `search`, `query`,
 *    `stats`, `list` and `sources list` exit 1 with `brain_missing` (reason `missing_brain`, the user acts) and create
 *    nothing: the store path is still absent (or still empty) and the gbrain home tree is unchanged. Once the store is
 *    back, the same commands read it again.
 *  - Regression: on rust-engine/main a597e7a6c6 each of these commands connected, owner election and the store's
 *    `open_dir` created a new empty store at the configured path, and the command answered from it.
 *  - Why existing coverage misses it: test/doctor-missing-brain-rust.test.ts covers doctor only.
 *  - Seam: the real CLI entry in a child process (test/helpers/cli-spawn.ts) with the built addon; the store is made by
 *    `gbrain import` (a write still creates a new store) and moved with a rename.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
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

/** Everything under the gbrain home but the moved store, so "creates nothing" is checked on the whole tree. */
function listing(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (p === moved) continue;
      out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(join(home, '.gbrain'));
  return out.sort();
}

/** The seven read commands, each with the form that prints JSON when it has one. */
const COMMANDS: ReadonlyArray<{ label: string; args: string[]; json: boolean }> = [
  { label: 'status', args: ['status', '--json'], json: true },
  { label: 'get', args: ['get', 'alpha', '--json'], json: true },
  { label: 'search', args: ['search', 'alpha', '--json'], json: true },
  { label: 'query', args: ['query', 'alpha', '--no-expand', '--json'], json: true },
  { label: 'stats', args: ['stats', '--json'], json: true },
  { label: 'list', args: ['list', '--json'], json: true },
  { label: 'sources list', args: ['sources', 'list', '--json'], json: true },
];

function expectRefusal(r: { exitCode: number | null; stdout: string; stderr: string }, label: string): void {
  expect(r.exitCode, `${label}: ${r.stdout}${r.stderr}`).toBe(1);
  const text = `${r.stdout}${r.stderr}`;
  expect(text, label).toContain('brain_missing');
  expect(text, label).toContain('missing_brain');
  expect(text, label).toContain(store);
  expect(text, label).toContain('Nothing was created there.');
}

describe.skipIf(!HAVE_ADDON)('read commands refuse a configured Rust brain whose store is not there', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-read-missing-rust-'));
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

  for (const c of COMMANDS) {
    test(`${c.label}: brain_missing, exit 1, and no store created`, async () => {
      const before = listing();
      const r = await runCli(c.args, { home, env: env(), timeoutMs: 120_000 });
      expectRefusal(r, c.label);
      if (c.json && r.stdout.trim().startsWith('{')) {
        const out = JSON.parse(r.stdout) as Record<string, any>;
        expect(out.code).toBe('brain_missing');
        expect(out.reason).toBe('missing_brain');
        expect(out.fix?.actor).toBe('user');
      }
      expect(existsSync(store), `${c.label} created the store`).toBe(false);
      expect(listing()).toEqual(before);
    }, 180_000);
  }

  test('an empty folder where the store was (a bare mount point) is refused and stays empty', async () => {
    mkdirSync(store);
    try {
      for (const c of COMMANDS) {
        const r = await runCli(c.args, { home, env: env(), timeoutMs: 120_000 });
        expectRefusal(r, `${c.label} on an empty folder`);
        expect(readdirSync(store), c.label).toEqual([]);
      }
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  }, 600_000);

  test('the moved store is untouched, and the read commands read it again once it is back', async () => {
    expect(existsSync(join(moved, 'FORMAT'))).toBe(true);
    renameSync(moved, store);
    try {
      const got = await runCli(['get', 'alpha', '--json'], { home, env: env(), timeoutMs: 120_000 });
      expect(got.exitCode, got.stderr).toBe(0);
      expect(got.stdout).toContain('Alpha body.');
      const status = await runCli(['status', '--json'], { home, env: env(), timeoutMs: 120_000 });
      expect(status.exitCode, status.stderr).toBe(0);
    } finally {
      renameSync(store, moved);
    }
  }, 180_000);
});

describe.skipIf(!HAVE_ADDON)('a write creates a Rust store only for a brain that never had one', () => {
  let wHome: string;
  let wStore: string;
  let notes: string;
  const wEnv = () => ({ ...env() });

  beforeAll(() => {
    wHome = mkdtempSync(join(tmpdir(), 'gbrain-write-missing-rust-'));
    wStore = join(wHome, '.gbrain', 'brain.rust');
    mkdirSync(join(wHome, '.gbrain'), { recursive: true });
    writeFileSync(join(wHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: wStore }));
    notes = join(wHome, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'alpha.md'), '---\ntitle: Alpha\n---\nAlpha body.\n');
  });

  afterAll(() => {
    try { rmSync(wHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a brand-new brain: import creates the store (how a new Rust brain starts)', async () => {
    const r = await runCli(['import', notes, '--no-embed'], { home: wHome, env: wEnv(), timeoutMs: 120_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(existsSync(join(wStore, 'FORMAT'))).toBe(true);
  }, 180_000);

  test('the same brain with its store moved: import refuses with brain_missing and creates nothing', async () => {
    const away = `${wStore}.away`;
    renameSync(wStore, away);
    try {
      const r = await runCli(['import', notes, '--no-embed'], { home: wHome, env: wEnv(), timeoutMs: 120_000 });
      expect(r.exitCode, `${r.stdout}${r.stderr}`).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain('brain_missing');
      expect(existsSync(wStore), 'import replaced the moved store with an empty one').toBe(false);
    } finally {
      renameSync(away, wStore);
    }
  }, 180_000);

  test('a store under a folder that is gone (an unmounted drive): a write refuses and makes no folder', async () => {
    const drive = join(wHome, 'drive');
    const onDrive = join(drive, 'brain.rust');
    writeFileSync(join(wHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: onDrive }));
    try {
      const r = await runCli(['import', notes, '--no-embed'], { home: wHome, env: wEnv(), timeoutMs: 120_000 });
      expect(r.exitCode, `${r.stdout}${r.stderr}`).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain('brain_missing');
      expect(existsSync(drive), 'the write made the missing drive folder').toBe(false);
    } finally {
      writeFileSync(join(wHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: wStore }));
    }
  }, 180_000);
});

describe.skipIf(!HAVE_ADDON)('more ways a missing store must not be created', () => {
  let h: string;
  const cfg = (path: string) => writeFileSync(join(h, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: path }));
  beforeAll(() => {
    h = mkdtempSync(join(tmpdir(), 'gbrain-missing-more-rust-'));
    mkdirSync(join(h, '.gbrain'), { recursive: true });
  });
  afterAll(() => { try { rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ } });

  test('a brain that never had a store: reads (diag and gbrain call included) refuse and create nothing', async () => {
    const fresh = join(h, '.gbrain', 'fresh.rust');
    cfg(fresh);
    for (const args of [['get', 'alpha', '--json'], ['diag', '--json'], ['search', 'stats'], ['call', 'get_page', '{"slug":"alpha"}'], ['call', 'list_pages', '{}']]) {
      const r = await runCli(args, { home: h, env: env(), timeoutMs: 120_000 });
      expect(r.exitCode, `${args.join(' ')}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(`${r.stdout}${r.stderr}`, args.join(' ')).toContain('brain_missing');
      expect(existsSync(fresh), `${args.join(' ')} created the store`).toBe(false);
    }
  }, 600_000);

  test('a configured path with a trailing slash: a moved store is still recognised and a write refuses', async () => {
    const real = join(h, '.gbrain', 'slash.rust');
    const notes = join(h, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'alpha.md'), '---\ntitle: Alpha\n---\nAlpha body.\n');
    cfg(`${real}/`);
    const made = await runCli(['import', notes, '--no-embed'], { home: h, env: env(), timeoutMs: 120_000 });
    expect(made.exitCode, made.stderr).toBe(0);
    renameSync(real, `${real}.away`);
    const r = await runCli(['import', notes, '--no-embed'], { home: h, env: env(), timeoutMs: 120_000 });
    expect(r.exitCode, `${r.stdout}${r.stderr}`).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('brain_missing');
    expect(existsSync(real), 'the write replaced the moved store').toBe(false);
    // A command that opens the engine itself (not through the CLI connect) refuses the same way.
    const cache = await runCli(['cache', 'stats'], { home: h, env: env(), timeoutMs: 120_000 });
    expect(cache.exitCode, `${cache.stdout}${cache.stderr}`).not.toBe(0);
    expect(existsSync(real), 'cache stats replaced the moved store').toBe(false);
    renameSync(`${real}.away`, real);
  }, 600_000);
});

describe.skipIf(!HAVE_ADDON)('an embedded open still creates a new Rust store', () => {
  // `openEngine` takes postgres or pglite only; a library caller opens a Rust brain through the engine factory
  // (`createEngine`), which no CLI connect flag reaches: it creates a missing store as before.
  test('createEngine + connect on an absent store directory creates it', async () => {
    const { createEngine } = await import('../src/core/engine-factory.ts');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-embedded-rust-'));
    const path = join(dir, 'brain.rust');
    try {
      await withEnv({ GBRAIN_RUST_ENGINE_ADDON: ADDON }, async () => {
        const engine = await createEngine({ engine: 'rust', database_path: path });
        await engine.connect({ engine: 'rust', database_path: path } as never);
        try {
          expect(existsSync(join(path, 'FORMAT'))).toBe(true);
        } finally {
          await engine.disconnect();
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(!HAVE_ADDON)('an open that must find its store creates nothing (the CLI connect\'s second layer)', () => {
  test('create_store: false on an absent store refuses brain_missing at connect and makes no folder', async () => {
    const { createEngine } = await import('../src/core/engine-factory.ts');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-must-exist-rust-'));
    const path = join(dir, 'brain.rust');
    try {
      await withEnv({ GBRAIN_RUST_ENGINE_ADDON: ADDON }, async () => {
        const engine = await createEngine({ engine: 'rust', database_path: path, create_store: false });
        let code: unknown;
        try {
          await engine.connect({ engine: 'rust', database_path: path } as never);
        } catch (error) {
          code = (error as { code?: unknown }).code;
        } finally {
          await engine.disconnect().catch(() => undefined);
        }
        expect(code).toBe('brain_missing');
        expect(existsSync(path)).toBe(false);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
