/**
 * E2E Compiled Binary Test — Tier 1 (no API keys, no network)
 *
 * Regression guard for the Bun `--compile` asset embedding bug:
 * PGLite references its WASM, data, and extension tarballs via
 * `new URL("./pglite.wasm", import.meta.url)` etc. inside node_modules.
 * Bun's compiler bundles JS modules but does NOT auto-embed arbitrary
 * data files referenced this way, so the stock compile produces a binary
 * that crashes at runtime with "Extension bundle not found".
 *
 * src/core/pglite-engine.ts fixes this by importing each asset with
 * `with { type: 'file' }`, materializing extension tarballs to tmpdir,
 * and feeding the core WASM/data modules directly to PGLite.
 *
 * This test compiles the binary, runs it against a scratch config dir,
 * and asserts zero extension errors + clean list output. It catches
 * any regression that silently drops an asset from the compile.
 *
 * Run: bun test test/e2e/compiled-binary.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const BINARY = join(REPO_ROOT, 'bin', platform() === 'win32' ? 'gbrain-compiled-test.exe' : 'gbrain-compiled-test');

let tmpHome: string;

beforeAll(() => {
  const build = spawnSync('bun', ['build', '--compile', '--outfile', BINARY, 'src/cli.ts'], {
    cwd: REPO_ROOT, encoding: 'utf-8', timeout: 120_000,
  });
  if (build.status !== 0) throw new Error(`Compile failed: ${build.stderr || build.stdout}`);

  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-compiled-test-'));
  const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
  const init = spawnSync(BINARY, ['init'], { encoding: 'utf-8', timeout: 60_000, env });
  if (init.status !== 0) {
    throw new Error(`gbrain init failed (status=${init.status}): ${init.stderr || init.stdout}`);
  }
}, 180_000);

afterAll(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  try { rmSync(BINARY, { force: true }); } catch { /* best-effort */ }
});

function runBinary(args: string[]) {
  // homedir() on Windows reads USERPROFILE; on Unix, HOME.
  const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
  return spawnSync(BINARY, args, { encoding: 'utf-8', timeout: 30_000, env });
}

describe('compiled binary: PGLite asset embedding', () => {
  // Per-test timeout has to cover the first-run initdb (PGLite bootstraps
  // a fresh cluster, takes ~5-10s on a cold machine).
  test('list against fresh PGLite brain runs clean', () => {
    const r = runBinary(['list', '-n', '5']);
    const combined = (r.stdout || '') + (r.stderr || '');
    expect(combined).not.toContain('Extension bundle not found');
    expect(combined).not.toContain('Failed to fetch extension');
    expect(combined).not.toContain('pglite.data');
    expect(combined).not.toContain('pglite.wasm');
    expect(combined).not.toContain('initdb.wasm');
    expect(r.status).toBe(0);
  }, 30_000);

  test('search against existing PGLite brain runs clean', () => {
    const r = runBinary(['search', 'anything']);
    const combined = (r.stdout || '') + (r.stderr || '');
    expect(combined).not.toContain('Extension bundle not found');
    expect(combined).not.toContain('Failed to fetch extension');
    expect(r.status).toBe(0);
  }, 30_000);
});
