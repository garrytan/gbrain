/**
 * G4.1 (wave 16): the allowlist block moved from secret-scan.ts to src/core/secret-scan-allowlist.ts so the scanner
 * stays under the 1500-line module cap. This file tests the path / fingerprint / glob behaviour THROUGH the new module
 * and pins the import surface: every name is still exported from secret-scan.ts and is the same function.
 * (test/secret-scan.test.ts keeps its own allowlist cases through the old import path.)
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as allowlist from '../src/core/secret-scan-allowlist.ts';
import * as scanner from '../src/core/secret-scan.ts';

const { ALLOWLIST_FINGERPRINT_MIN_HEX, SCAN_ALLOW_FILENAME, globToRegExp, loadWorkspaceAllowlist, matchesGlob, pathAllowlisted, valueAllowlisted } = allowlist;

describe('import surface', () => {
  test('secret-scan.ts re-exports every allowlist name as the same function or value', () => {
    for (const name of ['ALLOWLIST_FINGERPRINT_MIN_HEX', 'SCAN_ALLOW_FILENAME', 'globToRegExp', 'loadWorkspaceAllowlist', 'matchesGlob', 'pathAllowlisted', 'valueAllowlisted'] as const) {
      expect((scanner as Record<string, unknown>)[name], name).toBe((allowlist as Record<string, unknown>)[name]);
    }
    expect(SCAN_ALLOW_FILENAME).toBe('.gbrain-scan-allow');
    expect(ALLOWLIST_FINGERPRINT_MIN_HEX).toBe(16);
  });
});

describe('workspace allowlist file', () => {
  test('absent file is the empty default; entries parse with comments and blanks dropped; an unreadable root is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-scan-allow-'));
    try {
      expect(loadWorkspaceAllowlist(root)).toEqual([]);
      writeFileSync(join(root, SCAN_ALLOW_FILENAME), '# comment\n\nfixtures/**\n  sha256:0123456789abcdef  \n\n*.pem\n');
      expect(loadWorkspaceAllowlist(root)).toEqual(['fixtures/**', 'sha256:0123456789abcdef', '*.pem']);
      expect(loadWorkspaceAllowlist(join(root, 'nope', 'deeper'))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('glob dialect', () => {
  test('`**` crosses `/`, `*` stays in a segment, `?` is one non-slash char, a trailing `/` means everything under', () => {
    expect(globToRegExp('a/**/b.md').test('a/b.md')).toBe(true);
    expect(globToRegExp('a/**/b.md').test('a/x/y/b.md')).toBe(true);
    expect(globToRegExp('a/*/b.md').test('a/x/b.md')).toBe(true);
    expect(globToRegExp('a/*/b.md').test('a/x/y/b.md')).toBe(false);
    expect(globToRegExp('a/?.md').test('a/x.md')).toBe(true);
    expect(globToRegExp('a/?.md').test('a/xy.md')).toBe(false);
    expect(globToRegExp('a/?.md').test('a//.md')).toBe(false);
    expect(globToRegExp('fixtures/').test('fixtures/deep/file.txt')).toBe(true);
  });

  test('regex metacharacters in a glob are literal, and the compiled regex is cached per glob', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
    expect(globToRegExp('x(1)[2]{3}+$^|.md').test('x(1)[2]{3}+$^|.md')).toBe(true);
    expect(globToRegExp('**/*.pem')).toBe(globToRegExp('**/*.pem'));
  });

  test('gitignore flavour: a glob without `/` matches the basename at any depth; one with `/` is root-anchored', () => {
    expect(matchesGlob('*.pem', 'key.pem')).toBe(true);
    expect(matchesGlob('*.pem', 'sub/dir/key.pem')).toBe(true);
    expect(matchesGlob('.gbrain/**', '.gbrain/config.json')).toBe(true);
    expect(matchesGlob('.gbrain/**', 'nested/.gbrain/config.json')).toBe(false);
    expect(matchesGlob('sub/*.pem', ['sub', 'key.pem'].join('/'))).toBe(true);
  });
});

describe('fingerprint and path checks', () => {
  const full = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  test('a fingerprint entry suppresses a value only at or past the 16-hex floor, case-insensitively', () => {
    expect(valueAllowlisted(full, ['sha256:0123456789abcdef'])).toBe(true);
    expect(valueAllowlisted(full, ['sha256:0123456789ABCDEF'])).toBe(true);
    expect(valueAllowlisted(full, [`sha256:${full}`])).toBe(true);
    expect(valueAllowlisted(full, ['sha256:0123456789abcde'])).toBe(false); // 15 hex: below the floor
    expect(valueAllowlisted(full, ['sha256:fedcba9876543210'])).toBe(false);
    expect(valueAllowlisted(full, ['*.pem', 'fixtures/**'])).toBe(false); // globs never match a value
    expect(valueAllowlisted(full, [])).toBe(false);
  });

  test('a path is allowlisted by any glob entry and never by a fingerprint entry', () => {
    expect(pathAllowlisted('sub/key.pem', ['*.pem'])).toBe(true);
    expect(pathAllowlisted('fixtures/x/y.txt', ['sha256:0123456789abcdef', 'fixtures/**'])).toBe(true);
    expect(pathAllowlisted('src/index.ts', ['*.pem', 'fixtures/**'])).toBe(false);
    expect(pathAllowlisted('sha256:0123456789abcdef', ['sha256:0123456789abcdef'])).toBe(false);
  });
});
