/**
 * #3753 (reimplemented with credit to @harshsahrawat-commits) — a `--force`
 * re-init with NO explicit engine flag must preserve a configured postgres
 * engine. Pre-fix, the PGLite default branch swallowed the postgres config:
 * running the deferred-setup hint's own command shape on a postgres brain
 * rewrote config.json to engine=pglite, orphaning the postgres data behind a
 * config that no longer pointed at it. Explicit flags (--pglite / --url)
 * still switch engines, by saying so.
 *
 * Subprocess-driven (runInit calls process.exit on several paths) with a
 * hermetic per-test GBRAIN_HOME, same pattern as test/init-mcp-only.test.ts.
 * The preserved-postgres fixture URL points at a closed loopback port
 * (nothing listens on 127.0.0.1:9), so the postgres connect fails fast AFTER
 * the routing decision under test — the assertions are on config.json, which
 * initPostgres only rewrites after a successful connect.
 */

import { describe, test as testRaw, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

// PGLite cold start + initSchema in the subprocess runs ~5–20s on loaded
// machines; the 5s bun default (bunfig timeout is ignored by bun) is too tight.
function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 120_000);
}

const REPO_ROOT = join(import.meta.dir, '..');

// Closed loopback port: connection refused immediately, deterministically,
// with no network dependence.
const PRESERVED_URL = 'postgresql://gbrain:gbrain@127.0.0.1:9/gbrain_preserved';

async function runCli(
  args: string[],
  opts: { gbrainHome: string; cwd: string; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
      env: {
        // Minimal env: ambient DATABASE_URL/GBRAIN_DATABASE_URL or provider
        // keys would change init's routing and detection tiers.
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GBRAIN_HOME: opts.gbrainHome,
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => { stdout += b.toString(); });
    child.stderr?.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

/** Fresh GBRAIN_HOME seeded with a postgres config, plus an empty cwd (so
 *  init's .md smart-detection scans nothing). GBRAIN_HOME is a PARENT dir:
 *  configDir() appends '.gbrain' itself. */
function makePostgresHome(): { home: string; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-init-preserve-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'gbrain-init-preserve-cwd-'));
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'postgres', database_url: PRESERVED_URL }, null, 2),
  );
  return {
    home,
    cwd,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function readConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf-8'));
}

describe('#3753 — --force re-init preserves a configured postgres engine', () => {
  test('no engine flag: postgres config survives (not rewritten to pglite)', async () => {
    const { home, cwd, cleanup } = makePostgresHome();
    try {
      const r = await runCli(['init', '--force', '--no-embedding'], { gbrainHome: home, cwd });
      const cfg = readConfig(home);
      // THE bug: pre-fix this came back 'pglite' — the default branch
      // rewrote the config and orphaned the postgres data.
      expect(cfg.engine).toBe('postgres');
      expect(cfg.database_url).toBe(PRESERVED_URL);
      // No shadow PGLite brain materialized in GBRAIN_HOME either.
      expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(false);
      expect(r.stderr).toMatch(/postgres engine preserved/);
    } finally {
      cleanup();
    }
  });

  test('--non-interactive without --url or env URL: preserved postgres URL is used instead of failing', async () => {
    const { home, cwd, cleanup } = makePostgresHome();
    try {
      const r = await runCli(['init', '--force', '--non-interactive', '--no-embedding'], { gbrainHome: home, cwd });
      expect(r.stderr).toMatch(/postgres engine preserved/);
      expect(r.stderr).not.toMatch(/--non-interactive requires --url/);
      const cfg = readConfig(home);
      expect(cfg.engine).toBe('postgres');
      expect(cfg.database_url).toBe(PRESERVED_URL);
    } finally {
      cleanup();
    }
  });

  test('explicit --pglite still switches engines', async () => {
    const { home, cwd, cleanup } = makePostgresHome();
    try {
      const r = await runCli(['init', '--force', '--pglite', '--no-embedding'], { gbrainHome: home, cwd });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/postgres engine preserved/);
      const cfg = readConfig(home);
      expect(cfg.engine).toBe('pglite');
    } finally {
      cleanup();
    }
  });

  test('explicit --url wins: no preservation, manual URL is dialed', async () => {
    const { home, cwd, cleanup } = makePostgresHome();
    try {
      const manual = 'postgresql://gbrain:gbrain@127.0.0.1:9/gbrain_other';
      const r = await runCli(['init', '--force', '--no-embedding', '--url', manual], { gbrainHome: home, cwd });
      expect(r.stderr).not.toMatch(/postgres engine preserved/);
      // Connect to the closed port fails before any config write: the
      // original config must be untouched (not clobbered by the manual URL,
      // and never flipped to pglite).
      const cfg = readConfig(home);
      expect(cfg.engine).toBe('postgres');
      expect(cfg.database_url).toBe(PRESERVED_URL);
    } finally {
      cleanup();
    }
  });
});

/** Fresh GBRAIN_HOME seeded with a PGLite config whose brain lives at a non-default path. */
function makePgliteHome(): { home: string; cwd: string; dbPath: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-init-keep-pglite-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'gbrain-init-keep-pglite-cwd-'));
  mkdirSync(join(home, '.gbrain'));
  const dbPath = join(home, 'kept-brain.pglite');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath }, null, 2));
  return {
    home, cwd, dbPath,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

describe('--non-interactive with no engine flag keeps the brain the config file names', () => {
  test('PGLite: re-runs against the configured brain instead of demanding --url', async () => {
    const { home, cwd, dbPath, cleanup } = makePgliteHome();
    try {
      const r = await runCli(['init', '--non-interactive', '--no-embedding'], { gbrainHome: home, cwd });
      expect(r.stderr).not.toMatch(/--non-interactive requires --url/);
      expect(r.exitCode).toBe(0);
      const cfg = readConfig(home);
      expect(cfg.engine).toBe('pglite');
      expect(cfg.database_path).toBe(dbPath);
      expect(existsSync(dbPath)).toBe(true);
      expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('Postgres: dials the configured URL instead of demanding --url (no --force needed)', async () => {
    const { home, cwd, cleanup } = makePostgresHome();
    try {
      const r = await runCli(['init', '--non-interactive', '--no-embedding'], { gbrainHome: home, cwd });
      expect(r.stderr).not.toMatch(/--non-interactive requires --url/);
      // The closed port refuses the connect after routing; the config is never rewritten or flipped to pglite.
      const cfg = readConfig(home);
      expect(cfg.engine).toBe('postgres');
      expect(cfg.database_url).toBe(PRESERVED_URL);
      expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('unchanged: with no config at all, --non-interactive still demands --url and writes nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-init-fresh-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'gbrain-init-fresh-cwd-'));
    try {
      const r = await runCli(['init', '--non-interactive', '--no-embedding'], { gbrainHome: home, cwd });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/--non-interactive requires --url/);
      expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * The same preservation for a configured Rust engine (`engine: 'rust'`, the opt-in store at `database_path`).
 * `init --non-interactive` on a configured PGLite or Postgres brain is covered by the block above (from #10048).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: `gbrain init` and `gbrain init --non-interactive` with no engine flag on a brain whose config says
 *    `engine: 'rust'` exit 0, report the existing brain, and keep that engine and store path; they never write a PGLite
 *    brain over it. A fresh `init --non-interactive` (no config, no engine flag) still demands --url and writes nothing.
 * 2. Fails when: init routes a Rust config into the PGLite default branch (src/commands/init.ts, the
 *    `keptEngineConfig` check), which rewrites config.json to engine=pglite at GBRAIN_HOME/.gbrain/brain.pglite and
 *    orphans the Rust store; or when --non-interactive on an existing rust config takes the Postgres branch and
 *    stops with "--non-interactive requires --url"; or when the fresh no-config path stops demanding --url.
 * 3. Existing coverage: the #3753 cases above seed only a postgres config, and only with --force; no other init test
 *    seeds a Rust config for --non-interactive or runs it with no config at all.
 * 4. Seams: none. Real CLI subprocess, hermetic GBRAIN_HOME. The repo's built addon is passed when it exists;
 *    the Rust cases never open the store, so they hold with or without it.
 */
describe('init with no engine flag preserves a configured rust engine', () => {
  const target = detectAddonTarget();
  const addon = target ? join(REPO_ROOT, 'rust', 'target', 'addon', `gbrain_engine.${target}.node`) : '';
  const env: Record<string, string> = addon && existsSync(addon) ? { GBRAIN_RUST_ENGINE_ADDON: addon } : {};

  function makeRustHome(): { home: string; cwd: string; store: string; cleanup: () => void } {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-init-preserve-rust-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'gbrain-init-preserve-rust-cwd-'));
    const store = join(home, 'rust-store');
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: store }, null, 2));
    return {
      home,
      cwd,
      store,
      cleanup: () => {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      },
    };
  }

  test('plain init: reports the rust brain, exits 0, config survives (not rewritten to pglite)', async () => {
    const { home, cwd, store, cleanup } = makeRustHome();
    try {
      const before = readFileSync(join(home, '.gbrain', 'config.json'), 'utf-8');
      const r = await runCli(['init'], { gbrainHome: home, cwd, env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`Existing rust brain at ${store} kept`);
      const cfg = readConfig(home);
      expect({ engine: cfg.engine, database_path: cfg.database_path }).toEqual({ engine: 'rust', database_path: store });
      expect(readFileSync(join(home, '.gbrain', 'config.json'), 'utf-8')).toBe(before);
      expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(false);
      expect(existsSync(store)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('init --non-interactive: exits 0 without demanding a Postgres URL, rust config survives', async () => {
    const { home, cwd, store, cleanup } = makeRustHome();
    try {
      const r = await runCli(['init', '--non-interactive'], { gbrainHome: home, cwd, env });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/--non-interactive requires --url/);
      const cfg = readConfig(home);
      expect({ engine: cfg.engine, database_path: cfg.database_path }).toEqual({ engine: 'rust', database_path: store });
      expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('init --json on a rust brain: one success document names the rust engine, config unchanged', async () => {
    const { home, cwd, store, cleanup } = makeRustHome();
    try {
      const r = await runCli(['init', '--json'], { gbrainHome: home, cwd, env });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim().split('\n').pop() ?? '')).toMatchObject({ status: 'success', engine: 'rust', path: store, config_unchanged: true });
      expect(readConfig(home).engine).toBe('rust');
    } finally {
      cleanup();
    }
  });

  test('--pglite still switches a rust config to pglite (an explicit flag wins)', async () => {
    const { home, cwd, cleanup } = makeRustHome();
    try {
      const r = await runCli(['init', '--pglite', '--no-embedding'], { gbrainHome: home, cwd, env });
      expect(r.exitCode).toBe(0);
      expect(readConfig(home).engine).toBe('pglite');
    } finally {
      cleanup();
    }
  });
});

describe('init --non-interactive engine routing', () => {
  test('no config and no engine flag: init --non-interactive still demands --url and writes no config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-init-noninteractive-fresh-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'gbrain-init-noninteractive-fresh-cwd-'));
    try {
      const r = await runCli(['init', '--non-interactive', '--no-embedding'], { gbrainHome: home, cwd });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/--non-interactive requires --url/);
      expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
      expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
