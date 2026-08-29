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
  opts: { gbrainHome: string; cwd: string },
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
