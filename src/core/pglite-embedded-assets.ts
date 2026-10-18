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
 *   - custom `vector` / `pg_trgm` extensions that write the embedded tarballs'
 *     files into PGLite's filesystem once the backend is up (see
 *     lazyExtension), replacing the stock extensions'
 *     `new URL("../vector.tar.gz", import.meta.url)` (which breaks under
 *     compile).
 *
 * All of these are read with `readFileSync`, which works on `/$bunfs` paths;
 * the tarballs are gunzipped and untarred in memory, so nothing is copied to a
 * temp file (PGLite's own loader streams a bundle with `fs.createReadStream`,
 * which does not work on `/$bunfs` paths).
 *
 * Guarded by scripts/check-pglite-embedded.sh (compiles a binary and asserts a
 * real PGLite query round-trips), mirroring scripts/check-wasm-embedded.sh.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
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
  startParams: string[];
}

/**
 * Backend start parameters, appended to PGLite's defaults by `build()`
 * (`[...PGlite.defaultStartParams, ...PGLITE_START_PARAM_OVERRIDES]`, defaults
 * first so the overrides win). PGLite is one
 * backend with no worker processes, yet a CREATE INDEX still plans parallel
 * workers from max_parallel_maintenance_workers, and pgvector's HNSW build
 * then reserves maintenance_work_mem as a shared area up front inside the
 * 2 GiB WASM heap that no worker ever uses. And WAL a single statement writes
 * past the automatic checkpoint trigger (max_wal_size / 1.9) wedges PGLite
 * (see pglite-engine/checkpoint-guard.ts, which checkpoints between
 * statements): an HNSW build WAL-logs its whole index in one statement, about
 * 2 GB at 250k 1024-dim chunks, past the 1 GB default's 539 MB trigger. 8 GB
 * puts the trigger at 4.3 GB, above the largest index the heap can build
 * (vector-index.ts PGLITE_HNSW_GRAPH_BUDGET_BYTES); the guard still
 * checkpoints at 256 MB between statements.
 */
export const PGLITE_START_PARAM_OVERRIDES = [
  '-c', 'max_parallel_maintenance_workers=0',
  '-c', 'max_wal_size=8GB',
];

let cached: Promise<EmbeddedPgliteOptions> | null = null;

/** One regular file of an extension tarball, path relative to PGLite's install prefix. */
export interface ExtensionFile { path: string; data: Uint8Array }

/**
 * Gunzip and untar an extension bundle in memory. PGLite's bundles are plain
 * ustar archives of regular files and directories; any other entry type
 * (links, pax headers) means the bundle format changed, so it fails loudly
 * instead of silently dropping files postgres would later need.
 */
export function readExtensionFiles(tarballPath: string): ExtensionFile[] {
  const tar = gunzipSync(readFileSync(tarballPath));
  const text = (start: number, length: number) => tar.toString('latin1', start, start + length).replace(/\0.*$/s, '');
  const files: ExtensionFile[] = [];
  for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0;) {
    const name = text(offset + 345, 155) ? `${text(offset + 345, 155)}/${text(offset, 100)}` : text(offset, 100);
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = text(offset + 156, 1);
    const dataStart = offset + 512;
    if (type === '0' || type === '') files.push({ path: name.replace(/^\.\//, ''), data: tar.subarray(dataStart, dataStart + size) });
    else if (type !== '5') throw new Error(`Unsupported entry type '${type}' for ${name} in PGLite extension bundle ${tarballPath}`);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * An extension whose files are written into PGLite's filesystem after the
 * backend starts, without PGLite's eager preload. The stock path streams the
 * bundle through gunzip and compiles and links every `.so` before the backend
 * starts, about 30 ms per open even when the command never touches a vector or
 * trigram. Postgres loads `$libdir/<name>.so` on its first call into the
 * library (a vector value, an HNSW or trigram index, CREATE EXTENSION), and
 * emscripten's dlopen then loads the file synchronously from the filesystem.
 * Nothing postgres runs before `init` (startup, WAL replay, PGLite's array-type
 * query) calls into either library.
 */
function lazyExtension(name: string, files: ExtensionFile[]): Extension {
  return {
    name,
    setup: async (_pg, emscriptenOpts) => {
      let mod: { FS: { mkdirTree(path: string): void; writeFile(path: string, data: Uint8Array): void }; WASM_PREFIX: string } | null = null;
      return {
        emscriptenOpts: { ...emscriptenOpts, preRun: [...(emscriptenOpts.preRun ?? []), (m: NonNullable<typeof mod>) => { mod = m; }] },
        init: async () => {
          if (!mod) throw new Error(`PGLite never ran the ${name} extension's preRun hook`);
          for (const file of files) {
            const target = `${mod.WASM_PREFIX}/${file.path}`;
            mod.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
            mod.FS.writeFile(target, file.data);
          }
        },
      };
    },
  };
}

async function build(): Promise<EmbeddedPgliteOptions> {
  const { paths } = await resolvePgliteAssetPaths();
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
    WebAssembly.compile(readFileSync(paths.pgliteWasm)),
    WebAssembly.compile(readFileSync(paths.initdbWasm)),
  ]);
  const fsBundle = new Blob([readFileSync(paths.fsBundle)]);

  // Same extension names as the stock `{ vector, pg_trgm }` so the schema's
  // CREATE EXTENSION statements resolve unchanged; see lazyExtension().
  const vector = lazyExtension('pgvector', readExtensionFiles(paths.vectorTarball));
  const pg_trgm = lazyExtension('pg_trgm', readExtensionFiles(paths.pgTrgmTarball));

  // The package import stays lazy and after resolvePgliteAssetPaths(): a top-level runtime import fails at module
  // load with the raw "Cannot find module" when the package is missing, before the tier-3 reinstall sentence above
  // can run (#6512; the module's contract since #4116 is "never fail at load"). The literal specifier keeps the
  // bundler embedding intact (scripts/check-pglite-embedded.sh).
  const { PGlite } = await import('@electric-sql/pglite'); // engine-dynamic-import-ok (module must load without the package, #6512)
  return {
    pgliteWasmModule, initdbWasmModule, fsBundle, extensions: { vector, pg_trgm },
    startParams: [...PGlite.defaultStartParams, ...PGLITE_START_PARAM_OVERRIDES],
  };
}

/**
 * Resolve the embedded PGLite runtime options. Cached: the WASM modules compile
 * once per process and are reusable across every PGlite instance; the tarballs
 * are read once. Spread the result into `PGlite.create({ ... })`.
 */
export function getEmbeddedPgliteOptions(): Promise<EmbeddedPgliteOptions> {
  if (!cached) cached = build();
  return cached;
}

/** The options with `shared_buffers` overridden for one open; `size` unset returns them unchanged. */
export function withSharedBuffers(options: EmbeddedPgliteOptions, size: string | undefined): EmbeddedPgliteOptions {
  return size ? { ...options, startParams: [...options.startParams, '-c', `shared_buffers=${size}`] } : options;
}
