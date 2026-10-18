/**
 * The recursive chunker's delimiter split must produce the same pieces as
 * the remaining-slice loop it replaced while scanning the text linearly.
 *
 * 1. Protects: chunk boundaries of every markdown page (pieces, their order,
 *    their offsets) and chunking time on large newline-free or
 *    delimiter-sparse pages (the old loop rescanned the remaining text for
 *    every absent delimiter on every piece: O(pieces x text)).
 * 2. Fails when: a cached next occurrence goes stale (different pieces or
 *    offsets than the oracle, including overlapping delimiters such as
 *    ['ab', 'a', 'b', 'aba']) or per-piece rescans come back (the indexOf
 *    scan-count probe).
 * 3. Existing coverage: test/chunker-spans-oracle.slow.test.ts compares
 *    whole chunkText output to the master chunker; it does not isolate the
 *    split or its cost shape.
 * 4. Seam: splitAtDelimiters is exported (@internal) for this test.
 */
import { describe, expect, test } from 'bun:test';
import { splitAtDelimiters } from '../../src/core/chunkers/recursive.ts';
import { CJK_CLAUSE_DELIMITERS, CJK_SENTENCE_DELIMITERS } from '../../src/core/cjk.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';

/** The pre-fix loop (master before the large-pages lanes), with offsets. */
function oracleSplitAtDelimiters(text: string, delimiters: string[], base: number): Array<{ text: string; s: number }> {
  const pieces: Array<{ text: string; s: number }> = [];
  let remaining = text;
  let consumed = 0;
  while (remaining.length > 0) {
    let earliest = -1;
    let earliestDelim = '';
    for (const delim of delimiters) {
      const idx = remaining.indexOf(delim);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        earliestDelim = delim;
      }
    }
    if (earliest === -1) {
      pieces.push({ text: remaining, s: base + consumed });
      break;
    }
    const cut = earliest + earliestDelim.length;
    const piece = remaining.slice(0, cut);
    if (piece.trim().length > 0) pieces.push({ text: piece, s: base + consumed });
    remaining = remaining.slice(cut);
    consumed += cut;
  }
  return pieces.filter(p => p.text.trim().length > 0);
}

const LEVELS: string[][] = [
  ['\n\n'],
  ['\n'],
  ['. ', '! ', '? ', '.\n', '!\n', '?\n', ...CJK_SENTENCE_DELIMITERS],
  ['; ', ': ', ', ', ...CJK_CLAUSE_DELIMITERS],
  ['ab', 'a', 'b', 'aba'],
  ['aa', 'a'],
];

const ALPHABET = ['a', 'b', ' ', '\n', '.', '!', '?', ';', ':', ',', 'x', '。', '！', '，', '、', '；', '\t', '😀'];

describe('splitAtDelimiters differential (old vs new)', () => {
  test('identical pieces and offsets over a seeded corpus', () => {
    const rand = mulberry32(0xde11_0a17);
    for (let k = 0; k < 20_000; k++) {
      const len = Math.floor(rand() * 60);
      let text = '';
      for (let i = 0; i < len; i++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const delimiters = LEVELS[k % LEVELS.length]!;
      const base = Math.floor(rand() * 1000);
      expect(splitAtDelimiters(text, delimiters, base)).toEqual(oracleSplitAtDelimiters(text, delimiters, base));
    }
  });

  test('pieces stay lossless apart from whitespace-only gaps', () => {
    const text = 'alice-example wrote. Then; acme-example replied!\n\nok，好。';
    for (const delimiters of LEVELS) {
      for (const p of splitAtDelimiters(text, delimiters, 0)) expect(text.slice(p.s, p.s + p.text.length)).toBe(p.text);
    }
  });
});

/** Characters String.prototype.indexOf examined while `fn` runs. */
function countIndexOfScan(fn: () => void): number {
  const indexOf = String.prototype.indexOf;
  let scanned = 0;
  String.prototype.indexOf = function (this: string, needle: string, from?: number): number {
    const start = Math.max(0, Math.min(this.length, from ?? 0));
    const idx = indexOf.call(this, needle, start);
    scanned += idx === -1 ? this.length - start : idx - start + needle.length;
    return idx;
  } as typeof String.prototype.indexOf;
  try {
    fn();
  } finally {
    String.prototype.indexOf = indexOf;
  }
  return scanned;
}

describe('splitAtDelimiters cost probe', () => {
  test('sentence split of a newline-free page scans O(text), not O(pieces x text)', () => {
    const sentence = 'alice-example wrote to acme-example about the quarterly plan, then waited. ';
    const text = sentence.repeat(Math.ceil(200_000 / sentence.length));
    const delimiters = LEVELS[2]!;
    let pieces = 0;
    const scanned = countIndexOfScan(() => { pieces = splitAtDelimiters(text, delimiters, 0).length; });
    expect(pieces).toBeGreaterThan(2_000);
    expect(scanned).toBeLessThanOrEqual(64 * text.length);
    // The probe discriminates: the replaced loop rescans every absent
    // delimiter over the remaining text for every piece.
    const oracleScanned = countIndexOfScan(() => { oracleSplitAtDelimiters(text, delimiters, 0); });
    expect(oracleScanned).toBeGreaterThan(500 * text.length);
  });
});
