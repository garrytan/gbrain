/**
 * #4116: two-tier PGLite asset resolution.
 *
 * In this dev checkout (nested node_modules) tier 1 must win with
 * source 'embedded'. The hoisted / broken lanes are covered end-to-end by
 * test/pglite-hoisted-install.test.ts (they need a synthetic layout a
 * unit test can't fake in-process — Bun resolves the anchor's specifiers
 * relative to the REAL module path).
 *
 * Also pins the assumption tier 2 is built on: `dirname(resolve('@electric-sql/pglite'))`
 * IS the dist dir and carries all five runtime assets — if a pglite upgrade
 * moves them, this fails here instead of in a broken bun-global install.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { resolvePgliteAssetPaths, getEmbeddedPgliteOptions, readExtensionFiles, PGLITE_START_PARAM_OVERRIDES } from '../src/core/pglite-embedded-assets.ts';

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

  test('startParams are PGLite defaults first, then the HNSW/WAL overrides (#6512 lazy import keeps the order)', async () => {
    const opts = await getEmbeddedPgliteOptions();
    expect(opts.startParams).toEqual([...PGlite.defaultStartParams, ...PGLITE_START_PARAM_OVERRIDES]);
    expect(PGLITE_START_PARAM_OVERRIDES).toEqual(['-c', 'max_parallel_maintenance_workers=0', '-c', 'max_wal_size=8GB']);
  });
});

describe('extension files load on first use (GBRA-92)', () => {
  test('each bundle yields its library, control file and install script', async () => {
    const { paths } = await resolvePgliteAssetPaths();
    const vector = new Map(readExtensionFiles(paths.vectorTarball).map(f => [f.path, f.data.byteLength]));
    const trgm = new Map(readExtensionFiles(paths.pgTrgmTarball).map(f => [f.path, f.data.byteLength]));
    for (const [files, name] of [[vector, 'vector'], [trgm, 'pg_trgm']] as const) {
      expect(files.get(`lib/postgresql/${name}.so`)).toBeGreaterThan(0);
      expect(files.get(`share/postgresql/extension/${name}.control`)).toBeGreaterThan(0);
      expect([...files.keys()].some(p => p.startsWith(`share/postgresql/extension/${name}--`) && p.endsWith('.sql'))).toBe(true);
    }
  });

  test('a bundle entry that is neither a file nor a directory is refused, not dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ext-bundle-'));
    try {
      writeFileSync(join(dir, 'real.so'), 'x');
      symlinkSync('real.so', join(dir, 'alias.so'));
      const tarball = join(dir, 'bundle.tar.gz');
      expect(Bun.spawnSync(['tar', '-czf', tarball, '-C', dir, 'real.so', 'alias.so']).exitCode).toBe(0);
      expect(() => readExtensionFiles(tarball)).toThrow(/Unsupported entry type '2' for alias\.so/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('vector and pg_trgm install and answer queries without PGLite preloading them', async () => {
    const db = await PGlite.create({ ...(await getEmbeddedPgliteOptions()) });
    try {
      await db.exec('CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;');
      await db.exec('CREATE TABLE items (id int, embedding vector(3), title text)');
      await db.exec("CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops)");
      await db.exec("CREATE INDEX ON items USING gin (title gin_trgm_ops)");
      await db.exec("INSERT INTO items VALUES (1, '[1,0,0]', 'alpha example'), (2, '[0,1,0]', 'beta example')");
      const { rows } = await db.query<{ id: number; d: number; s: number }>(
        "SELECT id, embedding <=> '[1,0,0]' AS d, similarity(title, 'alpha exampel') AS s FROM items ORDER BY embedding <=> '[1,0,0]' LIMIT 1");
      expect(rows[0]!.id).toBe(1);
      expect(rows[0]!.d).toBe(0);
      expect(rows[0]!.s).toBeGreaterThan(0.5);
    } finally {
      await db.close();
    }
  }, 60_000);
});
