/**
 * Guard against `$bunfs` data-directory paths in PGLite (issue #250).
 *
 * When gbrain is compiled with `bun build --compile`, Bun mounts the
 * bundled files under the `$bunfs://` virtual filesystem. The PGLite
 * WASM module expects a real on-disk path and will either throw an
 * opaque WASM panic or silently create a broken data directory — both
 * leave users with a half-initialized brain and no actionable signal.
 *
 * This helper detects the prefix up front so we can fail with a clear,
 * actionable error instead.
 *
 * Kept in its own module so it can be unit-tested without spinning up
 * PGLite (which is ~50 MB of WASM and is not friendly to isolated
 * tests).
 */

/**
 * Returns true iff the given path lives inside Bun's `$bunfs` virtual FS.
 *
 * Covers the documented shapes:
 *   - `$bunfs://...`          (URL-style)
 *   - `/$bunfs/...`           (absolute-path style, seen on Linux)
 *   - `$bunfs/...`            (relative-ish, seen when argv[1] is used)
 */
export function isBunfsPath(p: string | undefined | null): boolean {
  if (!p) return false;
  return p.startsWith('$bunfs')
    || p.startsWith('/$bunfs/')
    || p.includes('/$bunfs/')
    || p.startsWith('$bunfs://');
}

/**
 * Throw if the given path is a `$bunfs` path. Message points the user at
 * the documented `bun run src/cli.ts` workaround so they know what to do.
 */
export function assertRealFilesystemPath(p: string | undefined | null): void {
  if (!isBunfsPath(p)) return;
  throw new Error(
    `PGLite cannot use a Bun single-file-executable path for its data directory:\n` +
    `  ${p}\n\n` +
    `Bun's 'bun build --compile' mounts bundled files under $bunfs://, which is a\n` +
    `virtual filesystem that PGLite's WASM module cannot access.\n\n` +
    `Workarounds:\n` +
    `  - Run from source:  bun run src/cli.ts <command>\n` +
    `  - Or pass --database-path with a real on-disk path\n` +
    `    (e.g. ~/.gbrain/brain.pglite).\n\n` +
    `See https://github.com/garrytan/gbrain/issues/250 for background.`,
  );
}
