/**
 * .gstack/pregate.json allowlists gstack's `env.kv` secrets finding on the PGLite snapshot cache-key lines of the
 * workflow files, and nothing else. gstack (lib/pregate/allowlist.ts) tests an entry's pattern anchored at the
 * finding's column in the added line, as `^(?:pattern)(?![\w-])`; for `env.kv` that column is the value after
 * `key: `. This file applies the same anchoring to every cache-key line in .github/workflows (each must be covered)
 * and to secret-shaped values (none may be).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const policy = JSON.parse(readFileSync(join(ROOT, '.gstack/pregate.json'), 'utf8')) as { allowlist: Array<{ finding: string; paths?: string[]; pattern?: string; reason: string }> };
const entries = policy.allowlist.filter(e => e.finding === 'env.kv');
const covers = (value: string) => entries.some(e => new RegExp(`^(?:${e.pattern})(?![\\w-])`).test(value));

const WORKFLOWS = join(ROOT, '.github/workflows');
const cacheKeyValues = readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml')).flatMap(f =>
  readFileSync(join(WORKFLOWS, f), 'utf8').split('\n').flatMap(line => {
    const at = line.indexOf('key: pglite-snapshot');
    return at < 0 ? [] : [line.slice(at + 'key: '.length)];
  }));

describe('pregate allowlist: workflow cache keys', () => {
  test('one env.kv entry, scoped to workflow files and a pattern', () => {
    expect(entries).toHaveLength(1);
    expect(entries[0]!.paths).toEqual(['.github/workflows/*.yml']);
    expect(typeof entries[0]!.pattern).toBe('string');
  });

  test('every pglite-snapshot cache key in the workflows is covered', () => {
    expect(cacheKeyValues.length).toBeGreaterThan(0);
    for (const value of cacheKeyValues) expect({ value, covered: covers(value) }).toEqual({ value, covered: true });
  });

  test('a secret-shaped value on a key: line is still flagged', () => {
    for (const value of [
      'pglite-snapshot-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a',
      'pglite-snapshot-${{ runner.os }}-Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7Hj9Kl0Pq2Wr4',
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts') }}-Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', 'ghp_Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7Hj9Kl0Pq2W\\'') }}",
      'ghp_Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7Hj9Kl0Pq2Wr4',
    ]) expect({ value, covered: covers(value) }).toEqual({ value, covered: false });
  });
});
