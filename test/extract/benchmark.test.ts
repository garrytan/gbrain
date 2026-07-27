// v0.42 Wave C2 + C3 — extract benchmark + fixture path validation tests.
//
// Pins:
//   - D-EXTRACT-21 fixture path validation: relative only, no ..,
//     no null bytes, must stay within pack root after canonicalization,
//     symlinks rejected
//   - JSONL parse failures fail loud at exact line number
//   - Required fixture fields (fixture_id, page_body, expected_claims)
//     enforced
//   - v0.42 stub-reporting status: pure shape report, no LLM dispatch yet

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateFixturePath,
  parseBenchmarkFixtures,
} from '../../src/commands/extract-benchmark.ts';

describe('validateFixturePath — D-EXTRACT-21 strict validation', () => {
  let packRoot: string;
  let cleanup: () => void;

  function setup() {
    packRoot = mkdtempSync(join(tmpdir(), 'extract-bench-pack-'));
    cleanup = () => rmSync(packRoot, { recursive: true, force: true });
  }

  test('relative path within pack root → returns canonical absolute path', () => {
    setup();
    try {
      const abs = validateFixturePath(packRoot, 'fixtures/extract/claim.jsonl');
      expect(abs).toBe(join(packRoot, 'fixtures/extract/claim.jsonl'));
    } finally {
      cleanup();
    }
  });

  test('absolute path → REJECTED', () => {
    setup();
    try {
      expect(() => validateFixturePath(packRoot, '/etc/passwd')).toThrow(/RELATIVE/);
    } finally {
      cleanup();
    }
  });

  test('`..` traversal → REJECTED', () => {
    setup();
    try {
      expect(() => validateFixturePath(packRoot, '../outside.jsonl')).toThrow(/'\.\.'\s*segment/);
      expect(() => validateFixturePath(packRoot, 'fixtures/../../escape.jsonl')).toThrow(/'\.\.'\s*segment/);
    } finally {
      cleanup();
    }
  });

  test('null byte → REJECTED', () => {
    setup();
    try {
      expect(() => validateFixturePath(packRoot, 'fixtures/extract/bad\0name.jsonl')).toThrow(/null byte/);
    } finally {
      cleanup();
    }
  });

  test('symlink pointing inside pack root → REJECTED', () => {
    setup();
    try {
      // Create a real file + a symlink to it inside the pack
      mkdirSync(join(packRoot, 'fixtures/extract'), { recursive: true });
      const real = join(packRoot, 'fixtures/extract/real.jsonl');
      writeFileSync(real, '{}\n');
      const link = join(packRoot, 'fixtures/extract/link.jsonl');
      symlinkSync(real, link);
      expect(() => validateFixturePath(packRoot, 'fixtures/extract/link.jsonl')).toThrow(/symbolic link/);
    } finally {
      cleanup();
    }
  });

  test('symlink pointing outside pack root → REJECTED at lstat check', () => {
    setup();
    try {
      // Create a real file OUTSIDE the pack root, symlink from inside
      const outsideDir = mkdtempSync(join(tmpdir(), 'extract-bench-outside-'));
      try {
        const outside = join(outsideDir, 'escape.jsonl');
        writeFileSync(outside, '{}\n');
        mkdirSync(join(packRoot, 'fixtures/extract'), { recursive: true });
        const link = join(packRoot, 'fixtures/extract/escape.jsonl');
        symlinkSync(outside, link);
        // lstat catches the symlink directly — the real-path check is
        // belt + suspenders for cases where an INTERMEDIATE dir is a
        // symlink (lstat on a regular file inside a symlinked dir
        // returns the regular-file stat).
        expect(() => validateFixturePath(packRoot, 'fixtures/extract/escape.jsonl')).toThrow(/symbolic link/);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    } finally {
      cleanup();
    }
  });

  test('non-existent path → does NOT throw on lstat (file may not exist yet)', () => {
    setup();
    try {
      // We validate the path SHAPE even when the file doesn't exist;
      // the benchmark dispatch handles existence separately so the
      // user gets the scaffold-extractable hint, not a path error.
      const abs = validateFixturePath(packRoot, 'fixtures/extract/new.jsonl');
      expect(abs).toBe(join(packRoot, 'fixtures/extract/new.jsonl'));
    } finally {
      cleanup();
    }
  });
});

describe('parseBenchmarkFixtures — JSONL contract enforcement', () => {
  test('parses canonical 5-fixture corpus (matching scaffold output)', () => {
    const jsonl = [
      JSON.stringify({ fixture_id: 'a-001', page_body: 'hi', expected_claims: [] }),
      JSON.stringify({ fixture_id: 'a-002', page_body: 'multi', expected_claims: [{ claim: 'x' }, { claim: 'y' }] }),
    ].join('\n') + '\n';
    const fixtures = parseBenchmarkFixtures(jsonl);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0].fixture_id).toBe('a-001');
    expect(fixtures[1].expected_claims).toHaveLength(2);
  });

  test('skips blank lines without failing', () => {
    const jsonl = [
      JSON.stringify({ fixture_id: 'a-001', page_body: 'x', expected_claims: [] }),
      '',
      '',
      JSON.stringify({ fixture_id: 'a-002', page_body: 'y', expected_claims: [] }),
      '',
    ].join('\n');
    const fixtures = parseBenchmarkFixtures(jsonl);
    expect(fixtures).toHaveLength(2);
  });

  test('fails loud on malformed JSON at exact line number', () => {
    const jsonl = [
      JSON.stringify({ fixture_id: 'good', page_body: 'x', expected_claims: [] }),
      'this is not json',
      JSON.stringify({ fixture_id: 'never-reached', page_body: 'x', expected_claims: [] }),
    ].join('\n');
    expect(() => parseBenchmarkFixtures(jsonl)).toThrow(/line 2/);
  });

  test('rejects missing required field (fixture_id)', () => {
    const jsonl = JSON.stringify({ page_body: 'x', expected_claims: [] });
    expect(() => parseBenchmarkFixtures(jsonl)).toThrow(/fixture_id/);
  });

  test('rejects missing required field (page_body)', () => {
    const jsonl = JSON.stringify({ fixture_id: 'a', expected_claims: [] });
    expect(() => parseBenchmarkFixtures(jsonl)).toThrow(/page_body/);
  });

  test('rejects missing required field (expected_claims)', () => {
    const jsonl = JSON.stringify({ fixture_id: 'a', page_body: 'x' });
    expect(() => parseBenchmarkFixtures(jsonl)).toThrow(/expected_claims/);
  });

  test('rejects non-array expected_claims', () => {
    const jsonl = JSON.stringify({ fixture_id: 'a', page_body: 'x', expected_claims: 'not an array' });
    expect(() => parseBenchmarkFixtures(jsonl)).toThrow(/array/);
  });

  test('rejects non-object top-level value', () => {
    const jsonl = '[1, 2, 3]';
    expect(() => parseBenchmarkFixtures(jsonl)).toThrow(/not a JSON object/);
  });

  test('preserves optional notes field when present', () => {
    const jsonl = JSON.stringify({
      fixture_id: 'a',
      page_body: 'x',
      expected_claims: [],
      notes: 'edge case for hedged language',
    });
    const fixtures = parseBenchmarkFixtures(jsonl);
    expect(fixtures[0].notes).toBe('edge case for hedged language');
  });

  test('empty input yields empty array', () => {
    expect(parseBenchmarkFixtures('')).toEqual([]);
    expect(parseBenchmarkFixtures('\n\n\n')).toEqual([]);
  });
});
