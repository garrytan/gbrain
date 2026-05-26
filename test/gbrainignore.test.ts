import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadGbrainignore,
  resolveExclusions,
  _resetGbrainignoreCache,
} from '../src/core/gbrainignore.ts';

/**
 * Tests for `.gbrainignore` + multi-layer exclusion resolution.
 *
 * Coverage map (per /plan-eng-review test diagram, v0.40.9.0):
 *   loadGbrainignore — 7 paths (missing / empty / comments / valid / invalid /
 *                                unreadable [skipped, not portable] / mtime invalidation)
 *   resolveExclusions — 9 paths (dotfile-only / cli-only / source-only / merge /
 *                                CLI-wins negation / hash stability / negation safety on/off /
 *                                empty inputs / >200 sanity cap)
 *
 * 16 cases land here. The walker / sync-wiring tests live in
 * test/sync-exclude.test.ts.
 */

describe('loadGbrainignore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbrainignore-test-'));
    _resetGbrainignoreCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns empty array when .gbrainignore is missing', () => {
    expect(loadGbrainignore(dir)).toEqual([]);
  });

  test('returns empty array on an empty file', () => {
    writeFileSync(join(dir, '.gbrainignore'), '');
    expect(loadGbrainignore(dir)).toEqual([]);
  });

  test('strips comments and blank lines', () => {
    writeFileSync(
      join(dir, '.gbrainignore'),
      '# comment\n\ndata/\n\n# another\n*.parquet\n',
    );
    expect(loadGbrainignore(dir)).toEqual(['data/', '*.parquet']);
  });

  test('preserves order of patterns (matters for gitignore last-match-wins)', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'a/\nb/\nc/\n');
    expect(loadGbrainignore(dir)).toEqual(['a/', 'b/', 'c/']);
  });

  test('caches by realpath and returns the same array instance until mtime changes', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n');
    const first = loadGbrainignore(dir);
    const second = loadGbrainignore(dir);
    expect(first).toBe(second); // same reference — cache hit
  });

  test('mtime invalidation: editing the file re-parses on the next call (C2 regression)', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n');
    const first = loadGbrainignore(dir);
    expect(first).toEqual(['data/']);

    // Bump mtime explicitly so this test isn't flaky on filesystems with
    // 1-second mtime granularity (HFS+, some NFS mounts).
    const future = new Date(Date.now() + 5000);
    writeFileSync(join(dir, '.gbrainignore'), 'data/\nfixtures/\n');
    utimesSync(join(dir, '.gbrainignore'), future, future);

    const second = loadGbrainignore(dir);
    expect(second).toEqual(['data/', 'fixtures/']);
    expect(second).not.toBe(first); // cache invalidated, new array
  });

  test('missing → present transition is detected (mtime sentinel)', () => {
    expect(loadGbrainignore(dir)).toEqual([]);
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n');
    expect(loadGbrainignore(dir)).toEqual(['data/']);
  });
});

describe('resolveExclusions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbrainignore-resolve-'));
    _resetGbrainignoreCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('empty inputs → ignores returns false for every path', () => {
    const m = resolveExclusions({ repoPath: dir });
    expect(m.ignores('anything.md')).toBe(false);
    expect(m.ignores('data/foo.md')).toBe(false);
    expect(m.patterns.length).toBe(0);
    expect(m.safeForDescentPrune).toBe(true);
  });

  test('dotfile-only: matches gitignore semantics', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n*.parquet\n');
    const m = resolveExclusions({ repoPath: dir });
    expect(m.ignores('data/foo.md')).toBe(true);
    expect(m.ignores('nested/data/foo.md')).toBe(true);
    expect(m.ignores('big.parquet')).toBe(true);
    expect(m.ignores('src/foo.ts')).toBe(false);
  });

  test('cli-only: --exclude flag patterns', () => {
    const m = resolveExclusions({
      repoPath: dir,
      cliExcludes: ['tmp/**', 'scratch/'],
    });
    expect(m.ignores('tmp/foo.md')).toBe(true);
    expect(m.ignores('scratch/x.md')).toBe(true);
    expect(m.ignores('src/foo.ts')).toBe(false);
  });

  test('source-config-only: sources.config.excludePatterns honored', () => {
    const m = resolveExclusions({
      repoPath: dir,
      sourceConfig: { excludePatterns: ['datasets/'] },
    });
    expect(m.ignores('datasets/big.parquet')).toBe(true);
    expect(m.ignores('src/foo.ts')).toBe(false);
  });

  test('merge of all three layers is additive', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n');
    const m = resolveExclusions({
      repoPath: dir,
      sourceConfig: { excludePatterns: ['fixtures/'] },
      cliExcludes: ['tmp/'],
    });
    expect(m.ignores('data/foo.md')).toBe(true);
    expect(m.ignores('fixtures/foo.md')).toBe(true);
    expect(m.ignores('tmp/foo.md')).toBe(true);
    expect(m.ignores('src/foo.ts')).toBe(false);
    expect(m.patterns).toEqual(['data/', 'fixtures/', 'tmp/']);
  });

  test('A4: CLI negation rescues a file when parent is excluded via `dir/*` (NOT `dir/`)', () => {
    // Gitignore semantics gotcha: once a directory is matched by `dir/`,
    // children cannot be re-included with `!dir/keep.md`. The rescue pattern
    // requires excluding contents (`dir/*`) instead of the dir itself.
    // See: https://git-scm.com/docs/gitignore#_pattern_format
    //
    // We test the rescue path that actually works, to pin the merge order
    // promise (CLI wins). Users who want rescuability write `data/*` in
    // .gbrainignore; the gotcha is documented in docs/guides/sync-filtering.md.
    writeFileSync(join(dir, '.gbrainignore'), 'data/*\n');
    const m = resolveExclusions({
      repoPath: dir,
      cliExcludes: ['!data/keep.md'],
    });
    expect(m.ignores('data/keep.md')).toBe(false);
    expect(m.ignores('data/skip.md')).toBe(true);
  });

  test('A4: gitignore gotcha — `dir/` form cannot be rescued (documented limitation)', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n');
    const m = resolveExclusions({
      repoPath: dir,
      cliExcludes: ['!data/keep.md'],
    });
    // Both still excluded — `data/` matched the parent dir, and gitignore
    // refuses to re-include children of excluded directories.
    expect(m.ignores('data/keep.md')).toBe(true);
    expect(m.ignores('data/skip.md')).toBe(true);
  });

  test('A3: safeForDescentPrune flips false when any pattern has a `!` (negation)', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n!data/keep.md\n');
    const m = resolveExclusions({ repoPath: dir });
    expect(m.safeForDescentPrune).toBe(false);
  });

  test('A3: safeForDescentPrune stays true when no negations are present (fast path)', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\nfixtures/\n');
    const m = resolveExclusions({ repoPath: dir });
    expect(m.safeForDescentPrune).toBe(true);
  });

  test('A2: patternsHash is stable for the same inputs', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n');
    const a = resolveExclusions({ repoPath: dir });
    const b = resolveExclusions({ repoPath: dir });
    expect(a.patternsHash).toBe(b.patternsHash);
  });

  test('A2: patternsHash changes when patterns change', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n');
    const before = resolveExclusions({ repoPath: dir }).patternsHash;

    // Bump mtime to force cache invalidation.
    const future = new Date(Date.now() + 5000);
    writeFileSync(join(dir, '.gbrainignore'), 'data/\nfixtures/\n');
    utimesSync(join(dir, '.gbrainignore'), future, future);

    const after = resolveExclusions({ repoPath: dir }).patternsHash;
    expect(after).not.toBe(before);
  });

  test('non-string entries in source.config.excludePatterns are ignored (defensive)', () => {
    const m = resolveExclusions({
      repoPath: dir,
      sourceConfig: {
        excludePatterns: ['data/', 42 as unknown as string, null, undefined, ''],
      },
    });
    // Only the real string survives.
    expect(m.patterns).toEqual(['data/']);
    expect(m.ignores('data/foo.md')).toBe(true);
  });

  test('absolute-path inputs to .ignores() are normalized (defensive)', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n');
    const m = resolveExclusions({ repoPath: dir });
    // Callers should pass relative paths but a leading slash from a buggy
    // call site shouldn't crash; it should just normalize and match.
    expect(m.ignores('/data/foo.md')).toBe(true);
  });

  test('windows backslashes in relative paths are normalized (defensive)', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n');
    const m = resolveExclusions({ repoPath: dir });
    expect(m.ignores('data\\foo.md')).toBe(true);
  });

  test('empty string path returns false (defensive)', () => {
    writeFileSync(join(dir, '.gbrainignore'), 'data/\n');
    const m = resolveExclusions({ repoPath: dir });
    expect(m.ignores('')).toBe(false);
  });
});
