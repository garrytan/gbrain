/**
 * .gstack/pregate.json allowlists gstack's `env.kv` secrets finding on the PGLite snapshot cache-key lines of the
 * workflow files, on the generated operation-loader lines (an operation named like a secret, such as reveal_secret),
 * and on five Rust type annotations or match arms that read like `key: &RelationshipKey,` (each scoped to its own file),
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
  test('seven env.kv entries: this one, scoped to workflow files and a pattern, the operation-loader one, and five Rust lines', () => {
    expect(entries).toHaveLength(7);
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

describe('pregate allowlist: Rust type annotations the secrets check reads as keys', () => {
  const RUST_SRC = 'rust/crates/gbrain-store/src/';
  const secret = ['sk-live-', '0123456789abcdef', '0123456789abcdef'].join('');
  // Each Rust entry covers one line shape in one file: what the check reads as the value, and values that must stay flagged.
  const SHAPES: Array<{ path: string; covered: string[]; flagged: string[] }> = [
    { path: 'link_queries/link_temporal.rs', covered: ['&RelationshipKey,'], flagged: [`"${secret}",`, '&RelationshipKeyX,', '&RelationshipKey, secret'] },
    { path: 'persistence/effect_worker.rs', covered: ['Option<&str>,'], flagged: [`"${secret}",`, 'Option<&str>, x'] },
    { path: 'occ_kv.rs', covered: ['Mutex<HashMap<Vec<u8>, u64>>,'], flagged: [`"${secret}",`, 'Mutex<HashMap<Vec<u8>, u64>>, x'] },
    { path: 'write_attribution.rs', covered: ['Option<PrivacyPolicy>,'], flagged: [`"${secret}",`, 'Option<PrivacyPolicy>, x'] },
    { path: 'cli_reads/reads.rs', covered: [':Char(c) => {'], flagged: [`"${secret}",`, ':Char(c) => { x'] },
  ];
  const rustEntries = entries.slice(2);

  test('five entries, each for one exact file under the store crate, with no glob and no shared path', () => {
    expect(rustEntries).toHaveLength(5);
    expect(rustEntries.map(e => e.paths)).toEqual(SHAPES.map(s => [RUST_SRC + s.path]));
    for (const e of rustEntries) {
      expect(e.paths![0]).not.toContain('*');
      expect(typeof e.pattern).toBe('string');
      expect(e.reason.length).toBeGreaterThan(20);
    }
  });

  // gstack tests an entry's pattern against the added line from the column where the flagged value starts, as
  // `^(?:pattern)(?![\\w-])` (lib/pregate/allowlist.ts): the text before the value is never seen, so a pattern cannot name the
  // key, and `^\\s*token: ...` would match nothing. Anchoring is therefore `^pattern$`: the value starts the match and the
  // line ends it. One case per entry: a quoted credential followed by a comment that holds the annotation is still flagged,
  // because its own finding starts at the quoted value, and the pattern does not match there.
  const TAILS: Array<{ path: string; prefix: string; annotation: string; valueAt: (line: string) => number }> = [
    { path: 'link_queries/link_temporal.rs', prefix: '    key: ', annotation: '&RelationshipKey,', valueAt: l => l.indexOf(': ') + 2 },
    { path: 'persistence/effect_worker.rs', prefix: '    token: ', annotation: 'Option<&str>,', valueAt: l => l.indexOf(': ') + 2 },
    { path: 'occ_kv.rs', prefix: '    by_key: ', annotation: 'Mutex<HashMap<Vec<u8>, u64>>,', valueAt: l => l.indexOf(': ') + 2 },
    { path: 'write_attribution.rs', prefix: '        exclude_private: ', annotation: 'Option<PrivacyPolicy>,', valueAt: l => l.indexOf(': ') + 2 },
    { path: 'cli_reads/reads.rs', prefix: '                    Token::Char(c) => ', annotation: 'Token::Char(c) => {', valueAt: l => l.indexOf(':') + 1 },
  ];
  for (const t of TAILS) {
    test(`${t.path}: a line that only ends with the annotation is not covered at its credential`, () => {
      const pattern = entryFor(RUST_SRC + t.path)!.pattern!;
      expect(pattern.startsWith('^') && pattern.endsWith('$')).toBe(true);
      const line = `${t.prefix}"${secret}", // ${t.annotation}`;
      expect(anchored(pattern, line.slice(t.valueAt(line)))).toBe(false);
      expect(new RegExp(pattern).test(line)).toBe(false);
    });
  }

  test('each entry covers its own annotation and still flags a quoted credential on the same key', () => {
    for (const shape of SHAPES) {
      const entry = entryFor(RUST_SRC + shape.path);
      for (const value of shape.covered) expect({ path: shape.path, value, covered: anchored(entry?.pattern, value) }).toEqual({ path: shape.path, value, covered: true });
      for (const value of shape.flagged) expect({ path: shape.path, value, covered: anchored(entry?.pattern, value) }).toEqual({ path: shape.path, value, covered: false });
    }
  });
});
