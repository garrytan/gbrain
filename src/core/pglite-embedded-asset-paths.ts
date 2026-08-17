/**
 * Bundler anchor for PGLite's embedded runtime assets (#4116).
 *
 * This module exists ONLY as the static anchor for `bun build --compile`: the
 * five `with { type: 'file' }` imports below use literal repo-relative
 * specifiers, which is what lets the bundler see and embed the asset bytes at
 * build time. Keep the specifiers literal and byte-stable — an expression or
 * indirection here silently stops the bytes from being embedded and the
 * compiled binary regresses to the Bun-vfs ENOENT class (#1340).
 *
 * It is loaded via a literal `import()` from pglite-embedded-assets.ts because
 * these specifiers are UNRESOLVABLE in a hoisted package install: a bun-global
 * upgrade dedupes @electric-sql/pglite up to the global node_modules root, and
 * an eager static import then kills every command at module load (#4116). The
 * importer treats a rejected import of this module as "not the nested layout"
 * and falls back to module resolution.
 */

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

/** All five embedded asset paths, resolved by the bundler (or by Bun's runtime
 * resolver under `bun run` in a nested-node_modules checkout). */
export const EMBEDDED_PGLITE_ASSET_PATHS = {
  pgliteWasm: PGLITE_WASM_PATH as unknown as string,
  initdbWasm: INITDB_WASM_PATH as unknown as string,
  fsBundle: FS_BUNDLE_PATH as unknown as string,
  vectorTarball: VECTOR_TARBALL_PATH as unknown as string,
  pgTrgmTarball: PG_TRGM_TARBALL_PATH as unknown as string,
} as const;
