/**
 * v0.32.3 — drift-watch module unit tests.
 * Pins the curated watch-list + matchesWatchPattern semantics.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  RETRIEVAL_WATCH_PATTERNS,
  matchesWatchPattern,
  watchedFilesDrifted,
  filesDriftedSince,
  resolveGbrainSourceRoot,
} from '../src/core/eval/drift-watch.ts';

const created: string[] = [];
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

/** Unrelated scratch repo with a staged file that matches the watch list. */
function scratchRepoWithStagedSearchFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gb-drift-'));
  created.push(dir);
  const git = (args: string) =>
    execSync(`git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false ${args}`, {
      cwd: dir,
      stdio: 'pipe',
    });
  git('init -q');
  git('commit -q --allow-empty -m init');
  mkdirSync(join(dir, 'src/core/search'), { recursive: true });
  writeFileSync(join(dir, 'src/core/search/hybrid.ts'), 'export {};\n');
  git('add -A');
  return dir;
}

describe('RETRIEVAL_WATCH_PATTERNS canonical list', () => {
  test('includes src/core/search/ prefix', () => {
    expect(RETRIEVAL_WATCH_PATTERNS).toContain('src/core/search/');
  });

  test('includes the embedding file', () => {
    expect(RETRIEVAL_WATCH_PATTERNS).toContain('src/core/embedding.ts');
  });

  test('includes chunkers/ directory', () => {
    expect(RETRIEVAL_WATCH_PATTERNS).toContain('src/core/chunkers/');
  });

  test('includes the query operation definition', () => {
    expect(RETRIEVAL_WATCH_PATTERNS).toContain('src/core/operations.ts');
  });

  test('is frozen at module load', () => {
    expect(Object.isFrozen(RETRIEVAL_WATCH_PATTERNS)).toBe(true);
  });
});

describe('matchesWatchPattern semantics', () => {
  test('directory pattern matches any descendant', () => {
    expect(matchesWatchPattern('src/core/search/hybrid.ts')).toBe(true);
    expect(matchesWatchPattern('src/core/search/mode.ts')).toBe(true);
    expect(matchesWatchPattern('src/core/search/deep/nested/file.ts')).toBe(true);
  });

  test('directory pattern does NOT match a sibling with the same prefix', () => {
    // src/core/search-related-but-different/foo.ts should NOT match
    // src/core/search/ because the pattern ends with a slash.
    expect(matchesWatchPattern('src/core/searchengine.ts')).toBe(false);
    expect(matchesWatchPattern('src/core/searches/file.ts')).toBe(false);
  });

  test('bare file pattern requires exact equality', () => {
    expect(matchesWatchPattern('src/core/embedding.ts')).toBe(true);
    expect(matchesWatchPattern('src/core/embedding.test.ts')).toBe(false);
    expect(matchesWatchPattern('src/core/embedding')).toBe(false);
  });

  test('custom patterns work', () => {
    const custom = ['foo/', 'bar.ts'];
    expect(matchesWatchPattern('foo/x.ts', custom)).toBe(true);
    expect(matchesWatchPattern('bar.ts', custom)).toBe(true);
    expect(matchesWatchPattern('baz.ts', custom)).toBe(false);
  });

  test('non-matching path returns false', () => {
    expect(matchesWatchPattern('docs/eval/METRIC_GLOSSARY.md')).toBe(false);
    expect(matchesWatchPattern('test/foo.test.ts')).toBe(false);
    expect(matchesWatchPattern('README.md')).toBe(false);
  });
});

describe('filesDriftedSince + watchedFilesDrifted probe failure is distinguishable from a clean tree (#4606)', () => {
  test('missing repo root returns null, not an empty (clean) list', () => {
    expect(filesDriftedSince('/does/not/exist')).toBeNull();
  });

  test('a directory that is not a git work tree returns null', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gb-nogit-'));
    created.push(tmp);
    expect(filesDriftedSince(tmp)).toBeNull();
    expect(watchedFilesDrifted(tmp)).toBeNull();
  });

  test('a real repo with a staged watched file reports exactly that file', () => {
    const repo = scratchRepoWithStagedSearchFile();
    expect(watchedFilesDrifted(repo)).toEqual(['src/core/search/hybrid.ts']);
  });

  test('watchedFilesDrifted filters through the same matcher', () => {
    // Smoke test: should not throw on this repo. Could be empty.
    const out = watchedFilesDrifted(process.cwd());
    expect(Array.isArray(out)).toBe(true);
    for (const p of out ?? []) {
      expect(matchesWatchPattern(p)).toBe(true);
    }
  });
});

describe('resolveGbrainSourceRoot (#4606)', () => {
  test('resolves this source checkout from the module location', () => {
    const root = resolveGbrainSourceRoot();
    expect(root).not.toBeNull();
    expect(existsSync(join(root!, 'src', 'cli.ts'))).toBe(true);
  });

  test('compiled-binary virtual URL resolves to null', () => {
    expect(resolveGbrainSourceRoot('file:///$bunfs/root/src/core/eval/drift-watch.ts')).toBeNull();
  });

  test('a package dir without .git is not a source checkout', () => {
    const pkg = mkdtempSync(join(tmpdir(), 'gb-pkg-'));
    created.push(pkg);
    mkdirSync(join(pkg, 'src', 'core', 'eval'), { recursive: true });
    mkdirSync(join(pkg, 'skills'), { recursive: true });
    writeFileSync(join(pkg, 'src', 'cli.ts'), '');
    writeFileSync(join(pkg, 'skills', 'RESOLVER.md'), '');
    expect(resolveGbrainSourceRoot(`file://${join(pkg, 'src', 'core', 'eval', 'drift-watch.ts')}`)).toBeNull();
  });
});
