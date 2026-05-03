import { describe, test, expect } from 'bun:test';
import {
  isBunfsPath,
  assertRealFilesystemPath,
} from '../src/core/pglite-path-guard.ts';

// Regression coverage for https://github.com/garrytan/gbrain/issues/250:
// When `gbrain` is compiled with `bun build --compile`, Bun mounts bundled
// files under `$bunfs://`, which PGLite's WASM module cannot access. The
// previous failure mode was an opaque WASM panic or silent corruption; the
// fix is a loud, actionable error before PGLite even starts.

describe('isBunfsPath (issue #250)', () => {
  test('detects $bunfs:// URL-style paths', () => {
    expect(isBunfsPath('$bunfs://root/brain.pglite')).toBe(true);
  });

  test('detects $bunfs/... bare-prefix paths', () => {
    expect(isBunfsPath('$bunfs/root/brain.pglite')).toBe(true);
  });

  test('detects /$bunfs/... absolute-path style', () => {
    expect(isBunfsPath('/$bunfs/root/brain.pglite')).toBe(true);
  });

  test('detects embedded /$bunfs/ in a deeper path', () => {
    expect(isBunfsPath('/tmp/build/outdir/$bunfs/root/brain.pglite')).toBe(true);
  });

  test('accepts normal on-disk paths', () => {
    expect(isBunfsPath('/Users/me/.gbrain/brain.pglite')).toBe(false);
    expect(isBunfsPath('./brain.pglite')).toBe(false);
    expect(isBunfsPath('brain.pglite')).toBe(false);
    expect(isBunfsPath('/home/me/.gbrain/brain.pglite')).toBe(false);
  });

  test('is tolerant of empty/null/undefined', () => {
    expect(isBunfsPath(undefined)).toBe(false);
    expect(isBunfsPath(null)).toBe(false);
    expect(isBunfsPath('')).toBe(false);
  });
});

describe('assertRealFilesystemPath (issue #250)', () => {
  test('throws on $bunfs paths with an actionable error message', () => {
    let err: Error | null = null;
    try {
      assertRealFilesystemPath('$bunfs://root/brain.pglite');
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    const msg = err!.message;
    // Must mention PGLite (what failed).
    expect(msg).toMatch(/PGLite/);
    // Must mention the offending path.
    expect(msg).toContain('$bunfs://root/brain.pglite');
    // Must surface the documented workaround.
    expect(msg).toMatch(/bun run src\/cli\.ts/);
    // Must mention --database-path option.
    expect(msg).toMatch(/--database-path/);
    // Must point at the issue for context.
    expect(msg).toMatch(/issues\/250/);
  });

  test('no-op on normal paths', () => {
    expect(() => assertRealFilesystemPath('/Users/me/.gbrain/brain.pglite')).not.toThrow();
    expect(() => assertRealFilesystemPath(undefined)).not.toThrow();
    expect(() => assertRealFilesystemPath(null)).not.toThrow();
    expect(() => assertRealFilesystemPath('')).not.toThrow();
  });

  test('throws on every documented $bunfs shape', () => {
    expect(() => assertRealFilesystemPath('$bunfs/root/brain.pglite')).toThrow(/PGLite/);
    expect(() => assertRealFilesystemPath('/$bunfs/root/brain.pglite')).toThrow(/PGLite/);
    expect(() => assertRealFilesystemPath('/tmp/$bunfs/root/brain.pglite')).toThrow(/PGLite/);
  });
});
