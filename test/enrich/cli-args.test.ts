/**
 * Pure `parseArgs` coverage for `--slugs` / `--slug-file` / `--evidence-scope`
 * (feat: --slugs targeting + --evidence-scope federated grounding). No
 * engine — runs in the fast parallel loop.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, EVIDENCE_SCOPES } from '../../src/commands/enrich.ts';

describe('parseArgs — --slugs', () => {
  test('comma-separated list', () => {
    const out = parseArgs(['--slugs', 'people/alice,people/bob']);
    expect(out.slugs).toEqual(['people/alice', 'people/bob']);
  });
  test('trims whitespace, drops empties', () => {
    const out = parseArgs(['--slugs', ' people/alice , , people/bob ']);
    expect(out.slugs).toEqual(['people/alice', 'people/bob']);
  });
  test('repeatable: multiple --slugs accumulate', () => {
    const out = parseArgs(['--slugs', 'people/alice', '--slugs', 'people/bob']);
    expect(out.slugs).toEqual(['people/alice', 'people/bob']);
  });
  test('empty list is an error', () => {
    const out = parseArgs(['--slugs', '']);
    expect(out.error).toBeTruthy();
  });
});

describe('parseArgs — --slug-file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-enrich-slugfile-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('reads one slug per line, ignores blanks and #-comments', () => {
    const path = join(dir, 'slugs.txt');
    writeFileSync(path, '# comment\npeople/alice\n\npeople/bob\n');
    const out = parseArgs(['--slug-file', path]);
    expect(out.slugs).toEqual(['people/alice', 'people/bob']);
  });
  test('combines with --slugs', () => {
    const path = join(dir, 'slugs2.txt');
    writeFileSync(path, 'people/carol\n');
    const out = parseArgs(['--slugs', 'people/alice', '--slug-file', path]);
    expect(out.slugs).toEqual(['people/alice', 'people/carol']);
  });
  test('missing file is an error, not a crash', () => {
    const out = parseArgs(['--slug-file', join(dir, 'does-not-exist.txt')]);
    expect(out.error).toBeTruthy();
  });
  test('empty file is an error', () => {
    const path = join(dir, 'empty.txt');
    writeFileSync(path, '\n\n# only comments\n');
    const out = parseArgs(['--slug-file', path]);
    expect(out.error).toBeTruthy();
  });
});

describe('parseArgs — --evidence-scope', () => {
  test('accepts each documented value', () => {
    for (const scope of EVIDENCE_SCOPES) {
      const out = parseArgs(['--evidence-scope', scope]);
      expect(out.evidenceScope).toBe(scope);
      expect(out.error).toBeUndefined();
    }
  });
  test('omitted → undefined (default own behavior downstream)', () => {
    const out = parseArgs(['--thin']);
    expect(out.evidenceScope).toBeUndefined();
  });
  test('rejects an unknown value', () => {
    const out = parseArgs(['--evidence-scope', 'everywhere']);
    expect(out.error).toBeTruthy();
  });
});
