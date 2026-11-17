/**
 * isWriteTargetContained (src/core/path-confine.ts) accepts a write target
 * under a folder named `..drafts` and still refuses one that leaves the root.
 * It guards the write-through file sinks (takes, API and Google sources).
 *
 * Authoring gate:
 * 1. Protects: a page written to `<root>/..drafts/page.md` (folder present or
 *    not yet created, or reached through an in-root symlink to a `..real`
 *    folder) is allowed; a target outside the root (a `../` path, a sibling
 *    folder that shares the root's name prefix, or a symlinked parent that
 *    points outside) is still refused.
 * 2. Regression that fails it: the check treating any relative path that starts
 *    with the two characters `..` as "outside" instead of only a `..` path
 *    component, which refuses a legal first folder such as `..drafts`; or
 *    loosening it so an outside target passes.
 * 3. Why existing coverage misses it: path-confine.test.ts uses ordinary
 *    folder names for both the allowed and the refused cases.
 * 4. Production seam: none. isWriteTargetContained is exported and used
 *    directly on real temp dirs, as path-confine.test.ts does.
 *
 * relativeEscapesRoot is the shared check behind every such site. Its cases run
 * with both path.posix and path.win32, so backslash and drive-letter shapes
 * are checked on POSIX CI, where path.relative never produces them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, posix, win32 } from 'path';

import { isWriteTargetContained, relativeEscapesRoot } from '../src/core/path-confine.ts';

let scratch: string;
let root: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-confine-dotdot-')));
  root = join(scratch, 'brain');
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('isWriteTargetContained with a first folder whose name starts with two dots', () => {
  test('allows a new file in a ..drafts folder that does not exist yet', () => {
    expect(isWriteTargetContained(join(root, '..drafts', 'page.md'), root)).toBe(true);
    expect(isWriteTargetContained(join(root, '..drafts', 'deep', 'page.md'), root)).toBe(true);
  });

  test('allows a new file in an existing ..drafts folder', () => {
    mkdirSync(join(root, '..drafts'));
    expect(isWriteTargetContained(join(root, '..drafts', 'page.md'), root)).toBe(true);
  });

  test('allows the ..drafts folder itself and a folder named three dots', () => {
    mkdirSync(join(root, '..drafts'));
    expect(isWriteTargetContained(join(root, '..drafts'), root)).toBe(true);
    expect(isWriteTargetContained(join(root, '...', 'page.md'), root)).toBe(true);
  });

  test('allows a write through an in-root symlink to a ..real folder', () => {
    mkdirSync(join(root, '..real'));
    symlinkSync('..real', join(root, 'people'), 'dir');
    expect(isWriteTargetContained(join(root, 'people', 'page.md'), root)).toBe(true);
  });

  test('allows a root that itself sits under a ..drafts folder', () => {
    const nested = join(scratch, '..drafts', 'brain');
    mkdirSync(nested, { recursive: true });
    expect(isWriteTargetContained(join(nested, 'page.md'), nested)).toBe(true);
  });
});

describe('isWriteTargetContained still refuses a target that leaves the root', () => {
  test('refuses a ../ path above the root', () => {
    expect(isWriteTargetContained(join(root, '..', 'page.md'), root)).toBe(false);
    expect(isWriteTargetContained(join(root, '..drafts', '..', '..', 'page.md'), root)).toBe(false);
  });

  test('refuses a file in a folder next to the root', () => {
    mkdirSync(join(scratch, 'outside'));
    expect(isWriteTargetContained(join(scratch, 'outside', 'page.md'), root)).toBe(false);
  });

  test('refuses a file in a ..outside folder next to the root', () => {
    mkdirSync(join(scratch, '..outside'));
    expect(isWriteTargetContained(join(scratch, '..outside', 'page.md'), root)).toBe(false);
  });

  test('refuses a file in a sibling folder that shares the root name prefix', () => {
    mkdirSync(join(scratch, 'brain2'));
    expect(isWriteTargetContained(join(scratch, 'brain2', 'page.md'), root)).toBe(false);
    expect(isWriteTargetContained(join(scratch, 'brain-backup', 'page.md'), root)).toBe(false);
  });

  test('refuses a write through an in-root symlink that points outside', () => {
    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'people'), 'dir');
    expect(isWriteTargetContained(join(root, 'people', 'page.md'), root)).toBe(false);
  });

  test('refuses a write through an in-root symlink that points at a ..outside folder', () => {
    const outside = join(scratch, '..outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'people'), 'dir');
    writeFileSync(join(outside, 'existing.md'), 'x');
    expect(isWriteTargetContained(join(root, 'people', 'page.md'), root)).toBe(false);
    expect(isWriteTargetContained(join(root, 'people', 'existing.md'), root)).toBe(false);
  });
});

describe('relativeEscapesRoot', () => {
  const inside = ['', 'a', 'a/b', '..drafts', '..drafts/a', '..x/y', '...', '.../a', '.hidden/a', 'a/../b', 'a/..'];
  const outside = ['..', '../', '../x', '../..drafts', '../../x'];

  test('posix: only a leading `..` component or an absolute path escapes', () => {
    for (const rel of inside) expect(`${rel}: ${relativeEscapesRoot(rel, posix)}`).toBe(`${rel}: false`);
    for (const rel of [...outside, '/etc/x', '/']) expect(`${rel}: ${relativeEscapesRoot(rel, posix)}`).toBe(`${rel}: true`);
  });

  test('win32: backslash, forward-slash and drive-letter shapes', () => {
    for (const rel of [...inside, '..drafts\\a', '...\\a', 'a\\b']) expect(`${rel}: ${relativeEscapesRoot(rel, win32)}`).toBe(`${rel}: false`);
    for (const rel of [...outside, '..\\', '..\\x', '..\\..drafts', 'D:\\x', 'D:/x', '\\\\server\\share\\x', '\\x']) {
      expect(`${rel}: ${relativeEscapesRoot(rel, win32)}`).toBe(`${rel}: true`);
    }
  });

  test('defaults to the host path module', () => {
    expect(relativeEscapesRoot('..drafts/a')).toBe(false);
    expect(relativeEscapesRoot('../a')).toBe(true);
  });
});
