/**
 * #5776: skill publication's bundle reader checked the whole relative path
 * for a backslash, which is the separator on Windows, so every nested bundle
 * file was rejected there and the shared-skills projection never completed.
 * The check is per path segment now. The win32 cases run on every OS through
 * path.win32; the readBundleFile case runs natively in the Windows
 * security-regressions job.
 */

import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join, posix, win32 } from 'path';
import { tmpdir } from 'os';

import { bundleRelativePathIsSafe, readBundleFile } from '../src/core/persistence/bundle-files.ts';

describe('#5776 bundle paths are checked per segment', () => {
  test('a nested Windows path is safe', () => {
    const rel = win32.relative('C:\\brain\\skills', 'C:\\brain\\skills\\sub\\nested.md');
    expect(rel).toBe('sub\\nested.md');
    expect(bundleRelativePathIsSafe(rel, win32.sep)).toBe(true);
  });

  test('unsafe segments are still refused on Windows', () => {
    expect(bundleRelativePathIsSafe('sub\\a:b.md', win32.sep)).toBe(false);
    expect(bundleRelativePathIsSafe('sub\\a\u0001b.md', win32.sep)).toBe(false);
    expect(bundleRelativePathIsSafe('sub\\a/b.md', win32.sep)).toBe(false);
    expect(bundleRelativePathIsSafe('sub\\\\b.md', win32.sep)).toBe(false);
  });

  test('POSIX keeps refusing a backslash inside a file name, and the depth bound holds', () => {
    expect(bundleRelativePathIsSafe('sub/nested.md', posix.sep)).toBe(true);
    expect(bundleRelativePathIsSafe('sub/a\\b.md', posix.sep)).toBe(false);
    expect(bundleRelativePathIsSafe('sub/a:b.md', posix.sep)).toBe(false);
    expect(bundleRelativePathIsSafe(Array.from({ length: 16 }, () => 'd').join('/'), posix.sep)).toBe(true);
    expect(bundleRelativePathIsSafe(Array.from({ length: 17 }, () => 'd').join('/'), posix.sep)).toBe(false);
  });

  test('readBundleFile reads a nested file on this platform', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-5776-')));
    try {
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'nested.md'), 'nested body');
      const read = readBundleFile(join(root, 'sub', 'nested.md'), root);
      expect(read?.bytes.toString('utf-8')).toBe('nested body');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
