/**
 * Unit tests for the synthesize phase scaffolding.
 *
 * Covers transcript-discovery branches (date filters, exclude regex,
 * minChars, multiple sources) and the compileExcludePatterns word-
 * boundary heuristic. Doesn't drive a real Anthropic call — full
 * cycle E2E lives in test/e2e/.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverTranscripts,
  readSingleTranscript,
  compileExcludePatterns,
} from '../src/core/cycle/transcript-discovery.ts';

let tmpDir: string;

function makeTranscript(name: string, body: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-test-'));
});

describe('compileExcludePatterns', () => {
  test('auto-wraps bare words in word-boundary regex (Q-3)', () => {
    const res = compileExcludePatterns(['medical']);
    expect(res).toHaveLength(1);
    // word boundary: matches "medical" but NOT "comedical"
    expect(res[0].test('medical advice')).toBe(true);
    expect(res[0].test('comedical')).toBe(false);
  });

  test('honors raw regex when input is non-bare-word', () => {
    const res = compileExcludePatterns(['^therapy:']);
    expect(res[0].test('therapy: today was hard')).toBe(true);
    expect(res[0].test('thinking about therapy:')).toBe(false);
  });

  test('skips invalid regex with warning, does not crash', () => {
    const res = compileExcludePatterns(['valid', '(broken[']);
    expect(res).toHaveLength(1); // only the valid one compiled
  });

  test('case-insensitive matching by default', () => {
    const res = compileExcludePatterns(['Medical']);
    expect(res[0].test('medical advice')).toBe(true);
    expect(res[0].test('MEDICAL ADVICE')).toBe(true);
  });

  test('empty / undefined input returns empty array', () => {
    expect(compileExcludePatterns(undefined)).toEqual([]);
    expect(compileExcludePatterns([])).toEqual([]);
    expect(compileExcludePatterns([''])).toEqual([]);
  });
});

describe('discoverTranscripts', () => {
  test('returns empty when corpusDir does not exist', () => {
    const out = discoverTranscripts({ corpusDir: '/nonexistent/path' });
    expect(out).toEqual([]);
  });

  test('returns transcripts above minChars, sorted by filePath', () => {
    makeTranscript('2026-04-25-session.txt', 'a'.repeat(2500));
    makeTranscript('2026-04-24-other.txt', 'b'.repeat(2500));
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out).toHaveLength(2);
    expect(out[0].basename).toBe('2026-04-24-other');
    expect(out[1].basename).toBe('2026-04-25-session');
  });

  test('skips transcripts below minChars', () => {
    makeTranscript('2026-04-25-short.txt', 'tiny');
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 2000 });
    expect(out).toEqual([]);
  });

  test('skips non-txt files', () => {
    makeTranscript('2026-04-25-foo.md', 'a'.repeat(3000));
    const out = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out).toEqual([]);
  });

  test('exclude_patterns filters out matched transcripts (word boundary)', () => {
    makeTranscript('2026-04-25-medical.txt', 'discussing medical advice ' + 'x'.repeat(3000));
    makeTranscript('2026-04-25-comedy.txt', 'comedical writing tips ' + 'x'.repeat(3000));
    const out = discoverTranscripts({
      corpusDir: tmpDir,
      minChars: 1000,
      excludePatterns: ['medical'],
    });
    expect(out).toHaveLength(1);
    expect(out[0].basename).toBe('2026-04-25-comedy');
  });

  test('--date filter restricts to one specific YYYY-MM-DD basename', () => {
    makeTranscript('2026-04-25-foo.txt', 'a'.repeat(3000));
    makeTranscript('2026-04-26-bar.txt', 'b'.repeat(3000));
    const out = discoverTranscripts({
      corpusDir: tmpDir,
      minChars: 1000,
      date: '2026-04-25',
    });
    expect(out).toHaveLength(1);
    expect(out[0].basename).toBe('2026-04-25-foo');
  });

  test('--from / --to range filters basename dates', () => {
    makeTranscript('2026-04-23-a.txt', 'a'.repeat(3000));
    makeTranscript('2026-04-25-b.txt', 'b'.repeat(3000));
    makeTranscript('2026-04-27-c.txt', 'c'.repeat(3000));
    const out = discoverTranscripts({
      corpusDir: tmpDir,
      minChars: 1000,
      from: '2026-04-24',
      to: '2026-04-26',
    });
    expect(out).toHaveLength(1);
    expect(out[0].basename).toBe('2026-04-25-b');
  });

  test('multiple sources (corpus + meeting transcripts) merged', () => {
    makeTranscript('2026-04-25-session.txt', 'a'.repeat(3000));
    const meetDir = mkdtempSync(join(tmpdir(), 'gbrain-meet-'));
    writeFileSync(join(meetDir, '2026-04-25-meeting.txt'), 'b'.repeat(3000));
    const out = discoverTranscripts({
      corpusDir: tmpDir,
      meetingTranscriptsDir: meetDir,
      minChars: 1000,
    });
    expect(out).toHaveLength(2);
    rmSync(meetDir, { recursive: true, force: true });
  });

  test('content_hash is stable for identical content, different for edits (A-3)', () => {
    makeTranscript('2026-04-25-a.txt', 'identical content ' + 'x'.repeat(3000));
    makeTranscript('2026-04-25-b.txt', 'identical content ' + 'x'.repeat(3000));
    const out1 = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out1[0].contentHash).toBe(out1[1].contentHash);

    // Edit one — hash changes
    makeTranscript('2026-04-25-a.txt', 'edited content ' + 'x'.repeat(3000));
    const out2 = discoverTranscripts({ corpusDir: tmpDir, minChars: 1000 });
    expect(out2[0].contentHash).not.toBe(out2[1].contentHash);
  });
});

describe('readSingleTranscript', () => {
  test('returns transcript above minChars', () => {
    const path = makeTranscript('hello.txt', 'a'.repeat(3000));
    const t = readSingleTranscript(path, { minChars: 1000 });
    expect(t).not.toBeNull();
    expect(t!.basename).toBe('hello');
  });

  test('returns null when below minChars', () => {
    const path = makeTranscript('hello.txt', 'tiny');
    const t = readSingleTranscript(path, { minChars: 2000 });
    expect(t).toBeNull();
  });

  test('returns null when content matches exclude pattern', () => {
    const path = makeTranscript('hello.txt', 'medical content ' + 'x'.repeat(3000));
    const t = readSingleTranscript(path, { minChars: 1000, excludePatterns: ['medical'] });
    expect(t).toBeNull();
  });

  test('throws on missing file', () => {
    expect(() => readSingleTranscript('/nonexistent/foo.txt')).toThrow();
  });

  test('infers date from YYYY-MM-DD basename', () => {
    const path = makeTranscript('2026-04-25-thing.txt', 'a'.repeat(3000));
    const t = readSingleTranscript(path, { minChars: 1000 });
    expect(t!.inferredDate).toBe('2026-04-25');
  });

  test('inferredDate null when basename does not start with YYYY-MM-DD', () => {
    const path = makeTranscript('random-basename.txt', 'a'.repeat(3000));
    const t = readSingleTranscript(path, { minChars: 1000 });
    expect(t!.inferredDate).toBeNull();
  });
});
