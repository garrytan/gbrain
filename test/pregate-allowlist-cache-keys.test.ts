/**
 * .gstack/pregate.json allowlists gstack's `env.kv` secrets finding on the PGLite snapshot cache-key lines of the
 * workflow files and on the generated operation-loader lines (an operation named like a secret, such as reveal_secret),
 * and nothing else. gstack (lib/pregate/allowlist.ts) tests an entry's pattern anchored at the
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
const LOADERS = 'src/core/operation-loaders.generated.ts';
const entryFor = (path: string) => entries.find(e => e.paths?.includes(path));
const anchored = (pattern: string | undefined, value: string) => new RegExp(`^(?:${pattern})(?![\\w-])`).test(value);
const covers = (value: string) => anchored(entryFor('.github/workflows/*.yml')?.pattern, value);
const coversLoader = (value: string) => anchored(entryFor(LOADERS)?.pattern, value);

const WORKFLOWS = join(ROOT, '.github/workflows');
const cacheKeyValues = readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml')).flatMap(f =>
  readFileSync(join(WORKFLOWS, f), 'utf8').split('\n').flatMap(line => {
    const at = line.indexOf('key: pglite-snapshot');
    return at < 0 ? [] : [line.slice(at + 'key: '.length)];
  }));

describe('pregate allowlist: workflow cache keys', () => {
  test('two env.kv entries: this one, scoped to workflow files and a pattern, and the operation-loader one', () => {
    expect(entries).toHaveLength(2);
    expect(entries[0]!.paths).toEqual(['.github/workflows/*.yml']);
    expect(typeof entries[0]!.pattern).toBe('string');
    expect(entries[1]).toEqual({ finding: 'env.kv', paths: [LOADERS], pattern: '\\[load_[a-z0-9_]+, "(?:[a-z][A-Za-z]*Operations|[a-z]+(?:_[a-z]+)+)"\\],?$', reason: expect.any(String) });
  });

  test('every pglite-snapshot cache key in the workflows is covered', () => {
    expect(cacheKeyValues.length).toBeGreaterThan(0);
    for (const value of cacheKeyValues) expect({ value, covered: covers(value) }).toEqual({ value, covered: true });
  });

  test('a secret-shaped value on a key: line is still flagged', () => {
    const hex = ['9f8a7b6c5d4e', '3f2a1b0c9d8e', '7f6a5b4c3d2e1f0a'].join('');
    const pat = ['gh', 'p_', 'Zx9Qw8Lk2Mn4', 'Bv6Cx1Za3Sd5', 'Fg7Hj9Kl0Pq2Wr4'].join('');
    for (const value of [
      `pglite-snapshot-${hex}`,
      'pglite-snapshot-${{ runner.os }}-Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7Hj9Kl0Pq2Wr4',
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts') }}-Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', '" + pat.slice(0, -2) + "\\'') }}",
      pat,
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('" + pat + "') }}",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', '" + pat + "') }}",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', './" + hex + "') }}",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', 'src/" + hex + ".ts') }}",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', 'src/Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7Hj9Kl0Pq2Wr4.ts') }}",
    ]) expect({ value, covered: covers(value) }).toEqual({ value, covered: false });
  });

  test('a long ** chain in a hashFiles argument is rejected without backtracking', () => {
    const value = "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src" + '/**'.repeat(26) + "X') }}";
    const started = performance.now();
    expect(covers(value)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('pregate allowlist: generated operation loaders', () => {
  // test-reads-source-ok[generated-artifact]: the allowlist must cover every line the checked-in generated loader table holds.
  const generated = readFileSync(join(ROOT, LOADERS), 'utf8').split('\n').flatMap(line => {
    const at = line.indexOf('[load_');
    return at < 0 ? [] : [line.slice(at)];
  });

  test('every loader line in the generated table is covered, a secret-named operation included', () => {
    expect(generated.length).toBeGreaterThan(0);
    for (const value of generated) expect({ value, covered: coversLoader(value) }).toEqual({ value, covered: true });
    expect(coversLoader('[load_secrets, "secretsOperations"],')).toBe(true);
  });

  test('a credential-shaped value in that file is still flagged', () => {
    const key = ['sk', 'proj', 'Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7Hj9Kl0Pq2Wr4'].join('-');
    for (const value of [
      `"${key}"`,
      `[load_secrets, "${key}"],`,
      `[load_secrets, "secretsOperations", "${key}"],`,
      `[load_secrets, "secretsOperations"], "${key}"`,
      `[${key}, "secretsOperations"],`,
      `[load_secrets, "${['AKIA', 'EXAMPLENOTREAL00'].join('')}"],`,
      `[load_secrets, "${['f8a7b6c5d4', 'e3f2a1b0c9'].join('')}"],`,
    ]) expect({ value, covered: coversLoader(value) }).toEqual({ value, covered: false });
  });
});
