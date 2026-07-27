/**
 * #774 NAV-1/NAV-2 path-containment guard (`isWithinRoot` in sync.ts).
 *
 * The guard decides whether a realpath-resolved file lives inside the
 * realpath-resolved git root. It backs BOTH the `--src-subpath` scope-entry
 * check and the per-file TOCTOU re-check in the incremental import drain.
 *
 * It used to be a string prefix test (`real.startsWith(rootReal + '/')`). That
 * hardcoded separator makes the guard fail CLOSED for every path on Windows,
 * where `realpathSync` returns `C:\repo\file.md` and the `C:\repo/` prefix can
 * never match: every file in the drain is recorded as a symlink escape and the
 * sync imports nothing. These cases pin the containment semantics against the
 * platform's own separator, so a future prefix-based rewrite is caught.
 *
 * The Windows regression itself is only OBSERVABLE on win32 — on POSIX the old
 * prefix form and the current `relative()` form agree on every case here.
 */

import { describe, test, expect } from 'bun:test';
import { join, sep, parse } from 'path';
import { isWithinRoot } from '../src/commands/sync.ts';

describe('isWithinRoot path containment (#774 NAV-1/NAV-2)', () => {
  const root = join(parse(process.cwd()).root, 'repo');

  test('accepts the root itself', () => {
    expect(isWithinRoot(root, root)).toBe(true);
  });

  test('accepts a direct child', () => {
    expect(isWithinRoot(join(root, 'page.md'), root)).toBe(true);
  });

  test('accepts a nested descendant (the case a hardcoded "/" broke on win32)', () => {
    expect(isWithinRoot(join(root, 'wiki', 'notes', 'page.md'), root)).toBe(true);
  });

  test('rejects the parent directory', () => {
    expect(isWithinRoot(parse(root).dir, root)).toBe(false);
  });

  test('rejects a path escaping upward', () => {
    expect(isWithinRoot(join(root, '..', 'outside', 'page.md'), root)).toBe(false);
  });

  test('rejects a sibling sharing the root as a string prefix', () => {
    expect(isWithinRoot(root + '-evil', root)).toBe(false);
    expect(isWithinRoot(join(root + '-evil', 'page.md'), root)).toBe(false);
  });

  test('rejects a sibling whose name extends the last segment', () => {
    expect(isWithinRoot(join(parse(root).dir, 'repository', 'page.md'), root)).toBe(false);
  });

  test('containment does not depend on a hardcoded forward slash', () => {
    // On win32 `sep` is '\\'; the child below is genuinely inside `root` and a
    // `root + '/'` prefix test would have rejected it.
    const child = `${root}${sep}sub${sep}page.md`;
    expect(isWithinRoot(child, root)).toBe(true);
  });
});
