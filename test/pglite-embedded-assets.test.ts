/**
 * #4116: two-tier PGLite asset resolution.
 *
 * In this dev checkout (nested node_modules) tier 1 must win with
 * source 'embedded'. The hoisted / broken lanes are covered end-to-end by
 * test/pglite-hoisted-install.serial.test.ts (they need a synthetic layout a
 * unit test can't fake in-process — Bun resolves the anchor's specifiers
 * relative to the REAL module path).
 *
 * Also pins the assumption tier 2 is built on: `dirname(resolve('@electric-sql/pglite'))`
 * IS the dist dir and carries all five runtime assets — if a pglite upgrade
 * moves them, this fails here instead of in a broken bun-global install.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resolvePgliteAssetPaths, getEmbeddedPgliteOptions } from '../src/core/pglite-embedded-assets.ts';

describe('resolvePgliteAssetPaths (#4116)', () => {
  test('dev checkout resolves via the embedded anchor with all five assets present', async () => {
    const { paths, source } = await resolvePgliteAssetPaths();
    expect(source).toBe('embedded');
    for (const [key, p] of Object.entries(paths)) {
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(0);
      // Each path ends with its canonical file name.
      expect(p.endsWith('.wasm') || p.endsWith('.data') || p.endsWith('.tar.gz')).toBe(true);
      expect(key.length).toBeGreaterThan(0);
    }
  });

  test('tier-2 assumption: module resolution of @electric-sql/pglite lands in a dist dir holding all five assets', () => {
    const nodeRequire = createRequire(import.meta.url);
    const dist = dirname(nodeRequire.resolve('@electric-sql/pglite'));
    for (const name of ['pglite.wasm', 'initdb.wasm', 'pglite.data', 'vector.tar.gz', 'pg_trgm.tar.gz']) {
      expect(existsSync(join(dist, name))).toBe(true);
    }
  });

  test('getEmbeddedPgliteOptions stays cached and keeps its four-field contract', async () => {
    const a = getEmbeddedPgliteOptions();
    const b = getEmbeddedPgliteOptions();
    expect(a).toBe(b); // same promise — one build per process
    const opts = await a;
    expect(opts.pgliteWasmModule).toBeInstanceOf(WebAssembly.Module);
    expect(opts.initdbWasmModule).toBeInstanceOf(WebAssembly.Module);
    expect(opts.fsBundle).toBeInstanceOf(Blob);
    expect(opts.extensions.vector.name).toBe('pgvector');
    expect(opts.extensions.pg_trgm.name).toBe('pg_trgm');
  });
});
