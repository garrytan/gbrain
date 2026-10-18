/**
 * `.gitleaksignore` holds only history-only fingerprints of synthetic test
 * values (each under a comment naming why). Every entry must be an exact
 * gitleaks git-mode fingerprint, `<commit sha>:<path>:<rule>:<line>`, so it
 * silences one finding in one past commit and never a pattern or a path.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('.gitleaksignore', () => {
  test('every entry is an exact commit-scoped fingerprint under an explaining comment', () => {
    const lines = readFileSync(join(import.meta.dir, '..', '..', '.gitleaksignore'), 'utf-8').split('\n');
    const entries = lines.map((line, i) => ({ line: line.trim(), i })).filter(({ line }) => line && !line.startsWith('#'));
    expect(entries.length).toBeGreaterThan(0);
    for (const { line, i } of entries) {
      expect(line).toMatch(/^[0-9a-f]{40}:[^:\s]+:[a-z0-9-]+:\d+$/);
      const above = lines.slice(0, i).reverse().find(l => l.trim() !== '' && !/^[0-9a-f]{40}:/.test(l.trim()));
      expect(above?.trim().startsWith('#')).toBe(true);
    }
  });
});
