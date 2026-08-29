/**
 * Embedded PGLite runtime assets [ENG-6 pattern].
 *
 * `bin/gbrain` ships via `bun build --compile`. That bundles our JS into a
 * read-only vfs (`/$bunfs/root`) but does NOT embed PGLite's runtime payload:
 * `pglite.wasm`, `initdb.wasm`, `pglite.data`, and the per-extension tarballs
 * (`vector.tar.gz`, `pg_trgm.tar.gz`). PGLite resolves those relative to its
 * own `import.meta.url`, which points inside `/$bunfs` in a compiled binary, so
 * a compiled `gbrain serve`/`init` on a PGLite brain used to fail with a bunfs
 * ENOENT (Bun vfs #1340 — see classifyPgliteInitError's `bunfs` verdict).
 *
 * Fix: embed every asset with Bun's `import ... with { type: 'file' }` (the same
 * mechanism as the tree-sitter WASMs in src/core/chunkers/code.ts and the
 * bootstrap templates in src/core/bootstrap/assets.ts). Each import resolves to
 * a runtime FILE PATH string that is readable in BOTH modes — the real
 * node_modules path under `bun run`, a `/$bunfs/root/...` path in the compiled
 * binary. Those file-typed imports live in pglite-embedded-asset-paths.ts (the
 * bundler ANCHOR) and are reached through resolvePgliteAssetPaths()'s tiered
 * lookup, because a bun-global install hoists @electric-sql/pglite out of
 * gbrain's own node_modules on upgrade and the anchor's repo-relative
 * specifiers stop resolving (#4116) — tier 2 then derives the dist dir from
 * module resolution instead. We hand PGLite the assets via PGliteOptions:
 *
 *   - `pgliteWasmModule`  — pglite.wasm bytes → WebAssembly.compile
 *   - `initdbWasmModule`  — initdb.wasm bytes → WebAssembly.compile
 *   - `fsBundle`          — pglite.data bytes → Blob
 *   - custom `vector` / `pg_trgm` extensions whose `setup()` returns a
 *     `bundlePath` URL pointing at the embedded tarball, replacing the stock
 *     extensions' `new URL("../vector.tar.gz", import.meta.url)` (which breaks
 *     under compile).
 *
 * All of these are read with `readFileSync`, which works on `/$bunfs` paths.
 *
 * One wrinkle: PGLite loads an extension tarball via `fs.createReadStream`
 * (gunzip pipeline), and `createReadStream` — unlike `readFileSync`/`existsSync`
 * — does NOT work on `/$bunfs` paths. So the two tarballs are materialized to a
 * real temp file first (content-addressed + atomic write + size-verified reuse)
 * and the `bundlePath` points there. This runs unconditionally in both modes
 * (in source mode it's a one-time copy of a ~15-46KB file), so there is no
 * fragile compiled-vs-source branch. The WASM modules and fsBundle need no
 * materialization because PGLite consumes them as bytes we already hold.
 *
 * Guarded by scripts/check-pglite-embedded.sh (compiles a binary and asserts a
 * real PGLite query round-trips), mirroring scripts/check-wasm-embedded.sh.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Extension } from '@electric-sql/pglite';

/** The five on-disk asset paths PGLite's runtime needs, however they were found. */
export interface PgliteAssetPaths {
  pgliteWasm: string;
  initdbWasm: string;
  fsBundle: string;
  vectorTarball: string;
  pgTrgmTarball: string;
}

const ASSET_FILES = {
  pgliteWasm: 'pglite.wasm',
  initdbWasm: 'initdb.wasm',
  fsBundle: 'pglite.data',
  vectorTarball: 'vector.tar.gz',
  pgTrgmTarball: 'pg_trgm.tar.gz',
} as const;

function allAssetsExist(paths: PgliteAssetPaths): boolean {
  return Object.values(paths).every((p) => typeof p === 'string' && p.length > 0 && existsSync(p));
}

/**
 * Derive PGLite's dist directory from module resolution — the SAME specifier
 * pglite-engine.ts imports, so the assets can never come from a different
 * pglite copy than the JS runtime actually loaded. Returns null when the
 * package cannot be resolved (compiled binary without the anchor, broken
 * install), letting the caller raise the actionable tier-3 error.
 */
function resolvePgliteDistDir(): string | null {
  // Primary: import.meta.resolve — synchronous under Bun, returns a file URL.
  try {
    const url = import.meta.resolve('@electric-sql/pglite');
    if (typeof url === 'string' && url.startsWith('file:')) {
      const dir = dirname(fileURLToPath(url));
      if (existsSync(join(dir, ASSET_FILES.pgliteWasm))) return dir;
    }
  } catch { /* fall through to createRequire */ }
  // Secondary: CJS resolution from this module's own URL.
  try {
    const nodeRequire = createRequire(import.meta.url);
    const dir = dirname(nodeRequire.resolve('@electric-sql/pglite'));
    if (existsSync(join(dir, ASSET_FILES.pgliteWasm))) return dir;
  } catch { /* both resolvers failed */ }
  return null;
}

/**
 * Two-tier asset resolution (#4116).
 *
 * Tier 1 (compiled binary + nested-node_modules checkout): load the bundler
 * anchor module, whose literal `with { type: 'file' }` imports the compiler
 * embeds. The import() REJECTS in a hoisted package install — bun-global
 * upgrades dedupe @electric-sql/pglite to the global root, so the anchor's
 * repo-relative specifiers stop resolving; that rejection is expected and
 * routes to tier 2. Exported for direct unit testing.
 *
 * Tier 2 (hoisted package lane): derive the dist dir via module resolution.
 *
 * Tier 3: throw one actionable error naming everything that was tried.
 */
export async function resolvePgliteAssetPaths(): Promise<{ paths: PgliteAssetPaths; source: 'embedded' | 'resolved' }> {
  let embeddedTried = 'anchor module did not resolve (hoisted or partial install)';
  try {
    // Literal specifier so the bundler statically follows it and embeds the
    // anchor's assets. Not an engine-live file, but marked for consistency:
    // engine-dynamic-import-ok (bundler anchor vs hoisted package layout, #4116)
    const anchor = await import('./pglite-embedded-asset-paths.ts');
    const paths: PgliteAssetPaths = { ...anchor.EMBEDDED_PGLITE_ASSET_PATHS };
    if (allAssetsExist(paths)) return { paths, source: 'embedded' };
    embeddedTried = `anchor resolved but assets missing on disk (looked near ${paths.pgliteWasm})`;
  } catch { /* hoisted layout: anchor specifiers unresolvable — expected, use tier 2 */ }

  const dist = resolvePgliteDistDir();
  if (dist) {
    const paths: PgliteAssetPaths = {
      pgliteWasm: join(dist, ASSET_FILES.pgliteWasm),
      initdbWasm: join(dist, ASSET_FILES.initdbWasm),
      fsBundle: join(dist, ASSET_FILES.fsBundle),
      vectorTarball: join(dist, ASSET_FILES.vectorTarball),
      pgTrgmTarball: join(dist, ASSET_FILES.pgTrgmTarball),
    };
    if (allAssetsExist(paths)) return { paths, source: 'resolved' };
  }

  throw new Error(
    'PGLite runtime assets not found. ' +
    `Tried the embedded bundle (${embeddedTried}) and module resolution of ` +
    `@electric-sql/pglite (${dist ? `dist dir ${dist} is incomplete` : 'package not resolvable from gbrain'}). ` +
    'This usually means the install is missing or hoisted in a way gbrain cannot reach. ' +
    'Reinstall from the canonical source: bun install -g github:garrytan/gbrain ' +
    '(or bun install in a source checkout). Never install from the npm registry: ' +
    'the npm package named gbrain is unrelated (see gbrain doctor).',
  );
}

/**
 * The subset of PGliteOptions we supply so PGLite never fetches/reads its
 * runtime assets relative to its own (bunfs) `import.meta.url`. Spread into the
 * options passed to `PGlite.create()`. `extensions` REPLACES the stock
 * `{ vector, pg_trgm }` — the map keys stay identical so the schema's
 * `CREATE EXTENSION vector` / `pg_trgm` resolve unchanged.
 */
export interface EmbeddedPgliteOptions {
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
  fsBundle: Blob;
  extensions: { vector: Extension; pg_trgm: Extension };
}

let cached: Promise<EmbeddedPgliteOptions> | null = null;

/**
 * Read an embedded tarball and copy it to a stable, content-addressed temp file
 * that `fs.createReadStream` can open (see module doc for why the raw bunfs path
 * can't be streamed). Content-addressing (sha256 of bytes) means a version bump
 * writes a fresh file; the size check re-writes over a truncated remnant from a
 * crashed writer; the tmp-then-rename keeps concurrent writers from tearing.
 */
function materializeTarball(embeddedPath: string, baseName: string): URL {
  const bytes = readFileSync(embeddedPath);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), 'gbrain-pglite-assets');
  mkdirSync(dir, { recursive: true });
  // 'vector.tar.gz' -> 'vector-<hash>.tar.gz' (keep the .tar.gz suffix intact).
  const dot = baseName.indexOf('.');
  const dest = join(dir, `${baseName.slice(0, dot)}-${hash}${baseName.slice(dot)}`);
  if (!(existsSync(dest) && statSync(dest).size === bytes.byteLength)) {
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
  }
  return pathToFileURL(dest);
}

async function build(): Promise<EmbeddedPgliteOptions> {
  const { paths } = await resolvePgliteAssetPaths();
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
    WebAssembly.compile(readFileSync(paths.pgliteWasm)),
    WebAssembly.compile(readFileSync(paths.initdbWasm)),
  ]);
  const fsBundle = new Blob([readFileSync(paths.fsBundle)]);

  const vectorBundle = materializeTarball(paths.vectorTarball, 'vector.tar.gz');
  const pgTrgmBundle = materializeTarball(paths.pgTrgmTarball, 'pg_trgm.tar.gz');

  // Custom extensions mirror the stock ones (dist/vector/index.js,
  // dist/contrib/pg_trgm.js) but hand back the embedded tarball's file URL
  // instead of `new URL("../vector.tar.gz", import.meta.url)`. vector passes the
  // emscripten opts through exactly as the stock extension does.
  const vector: Extension = {
    name: 'pgvector',
    setup: async (_pg, emscriptenOpts) => ({ emscriptenOpts, bundlePath: vectorBundle }),
  };
  const pg_trgm: Extension = {
    name: 'pg_trgm',
    setup: async () => ({ bundlePath: pgTrgmBundle }),
  };

  return { pgliteWasmModule, initdbWasmModule, fsBundle, extensions: { vector, pg_trgm } };
}

/**
 * Resolve the embedded PGLite runtime options. Cached: the WASM modules compile
 * once per process and are reusable across every PGlite instance; the tarballs
 * materialize once. Spread the result into `PGlite.create({ ... })`.
 */
export function getEmbeddedPgliteOptions(): Promise<EmbeddedPgliteOptions> {
  if (!cached) cached = build();
  return cached;
}
