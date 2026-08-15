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
 * binary. We then hand PGLite the assets directly via PGliteOptions:
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
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Extension } from '@electric-sql/pglite';

// The package's `exports` map does not expose `./dist/*`, so a bare package
// subpath (`@electric-sql/pglite/dist/pglite.wasm`) does NOT resolve under Bun.
// Reach the dist assets via a repo-relative node_modules path instead — this
// resolves in both `bun run` and `bun build --compile`.
// @ts-ignore — type: 'file' import attribute is valid Bun syntax, not in lib.d.ts
import PGLITE_WASM_PATH from '../../node_modules/@electric-sql/pglite/dist/pglite.wasm' with { type: 'file' };
// @ts-ignore
import INITDB_WASM_PATH from '../../node_modules/@electric-sql/pglite/dist/initdb.wasm' with { type: 'file' };
// @ts-ignore
import FS_BUNDLE_PATH from '../../node_modules/@electric-sql/pglite/dist/pglite.data' with { type: 'file' };
// @ts-ignore
import VECTOR_TARBALL_PATH from '../../node_modules/@electric-sql/pglite/dist/vector.tar.gz' with { type: 'file' };
// @ts-ignore
import PG_TRGM_TARBALL_PATH from '../../node_modules/@electric-sql/pglite/dist/pg_trgm.tar.gz' with { type: 'file' };

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
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
    WebAssembly.compile(readFileSync(PGLITE_WASM_PATH as unknown as string)),
    WebAssembly.compile(readFileSync(INITDB_WASM_PATH as unknown as string)),
  ]);
  const fsBundle = new Blob([readFileSync(FS_BUNDLE_PATH as unknown as string)]);

  const vectorBundle = materializeTarball(VECTOR_TARBALL_PATH as unknown as string, 'vector.tar.gz');
  const pgTrgmBundle = materializeTarball(PG_TRGM_TARBALL_PATH as unknown as string, 'pg_trgm.tar.gz');

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
