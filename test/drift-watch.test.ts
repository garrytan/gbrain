/**
 * v0.32.3 — drift-watch module unit tests.
 * Pins the curated watch-list + matchesWatchPattern semantics.
 */
import { describe, expect, test } from 'bun:test';
import {
  RETRIEVAL_WATCH_PATTERNS,
  matchesWatchPattern,
  watchedFilesDrifted,
  filesDriftedSince,
} from '../src/core/eval/drift-watch.ts';

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

describe('filesDriftedSince + watchedFilesDrifted graceful failure', () => {
  test('missing repo root returns empty array', () => {
    expect(filesDriftedSince('/does/not/exist')).toEqual([]);
  });

  test('watchedFilesDrifted filters through the same matcher', () => {
    // Smoke test: should not throw on this repo. Could be empty.
    const out = watchedFilesDrifted(process.cwd());
    expect(Array.isArray(out)).toBe(true);
    for (const p of out) {
      expect(matchesWatchPattern(p)).toBe(true);
    }
  });
});
