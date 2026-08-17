/**
 * #4116 regression: bun-global installs hoist @electric-sql/pglite OUT of
 * gbrain's own node_modules on upgrade, and the old eager static
 * `../../node_modules/...` file imports then rejected at MODULE LOAD, killing
 * every command with "Cannot find module ... pglite.wasm".
 *
 * Three synthetic layouts, each spawning a fresh bun process (Bun resolves
 * import specifiers against the importer's REAL path, so the two source files
 * are COPIED into a fake package — symlinking the package would resolve back
 * into the repo and silently pass):
 *
 *   hoisted  — pglite only in a PARENT node_modules (the bun-global shape)
 *              → tier 2, source 'resolved'   (pre-fix: hard crash)
 *   nested   — pglite in the package's own node_modules
 *              → tier 1, source 'embedded'
 *   broken   — no pglite anywhere above the package
 *              → tier 3, actionable error naming the reinstall command
 *
 * Serial: spawns subprocesses + writes tmpdirs.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const nodeRequire = createRequire(import.meta.url);
const REAL_PGLITE_PKG_DIR = dirname(dirname(nodeRequire.resolve('@electric-sql/pglite'))); // <pkg>/dist/index.js -> <pkg>

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Build TMP/pkg/src/core with real COPIES of the two source files. */
function makeFakePackage(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-hoisted-4116-'));
  cleanups.push(root);
  const core = join(root, 'pkg', 'src', 'core');
  mkdirSync(core, { recursive: true });
  for (const f of ['pglite-embedded-assets.ts', 'pglite-embedded-asset-paths.ts']) {
    copyFileSync(join(REPO, 'src', 'core', f), join(core, f));
  }
  return root;
}

function linkPglite(nodeModulesDir: string): void {
  const scope = join(nodeModulesDir, '@electric-sql');
  mkdirSync(scope, { recursive: true });
  symlinkSync(REAL_PGLITE_PKG_DIR, join(scope, 'pglite'));
}

async function resolveInSubprocess(root: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const script = [
    `const m = await import(${JSON.stringify(join(root, 'pkg', 'src', 'core', 'pglite-embedded-assets.ts'))});`,
    'const r = await m.resolvePgliteAssetPaths();',
    'console.log(JSON.stringify({ source: r.source }));',
  ].join('\n');
  const proc = Bun.spawn(['bun', '-e', script], {
    cwd: root, // NOT the repo — resolution must not walk into the repo via cwd
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe('hoisted-install asset resolution (#4116, serial)', () => {
  test('hoisted layout (pglite only in a parent node_modules) resolves via tier 2', async () => {
    const root = makeFakePackage();
    linkPglite(join(root, 'node_modules')); // parent root, NOT pkg/node_modules
    const r = await resolveInSubprocess(root);
    expect(r.stderr).not.toContain('Cannot find module');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ source: 'resolved' });
  }, 30_000);

  test('nested layout (pglite in the package own node_modules) stays on the embedded tier', async () => {
    const root = makeFakePackage();
    linkPglite(join(root, 'pkg', 'node_modules'));
    const r = await resolveInSubprocess(root);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ source: 'embedded' });
  }, 30_000);

  test('broken layout (no pglite anywhere) throws the actionable tier-3 error, not a raw resolver error', async () => {
    const root = makeFakePackage();
    const r = await resolveInSubprocess(root);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('PGLite runtime assets not found');
    expect(r.stderr).toContain('Reinstall');
    // The failure users hit pre-fix must not be the surface we show now.
    expect(r.stderr).not.toMatch(/Cannot find module '\.\.\/\.\.\/node_modules/);
  }, 30_000);
});
