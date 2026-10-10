/**
 * The single-pass word counter against the regex implementation it replaced
 * (copied verbatim below), and the O(1) concatenation the chunker's
 * greedyMerge relies on, across a mixed CJK / Latin / emoji / whitespace
 * fuzz corpus.
 */
import { describe, expect, test } from 'bun:test';
import {
  CJK_DENSITY_THRESHOLD,
  CJK_SLUG_CHARS,
  concatWordStats,
  countCJKAwareWords,
  isCJKDominant,
  wordCountOf,
  wordStats,
} from '../src/core/cjk.ts';
import { fuzzText, mulberry32 } from './chunkers/word-count-fuzz-corpus.ts';

function regexIsCJKDominant(s: string): boolean {
  const nonWhitespace = s.replace(/\s/g, '').length;
  if (nonWhitespace === 0) return false;
  const cjkMatches = s.match(new RegExp(`[${CJK_SLUG_CHARS}]`, 'g'));
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  return cjkCount / nonWhitespace >= CJK_DENSITY_THRESHOLD;
}

function regexCountCJKAwareWords(s: string): number {
  if (s.length === 0) return 0;
  return regexIsCJKDominant(s)
    ? s.replace(/\s/g, '').length
    : (s.match(/\S+/g) || []).length;
}

function fuzzStrings(seed: number, count: number): string[] {
  const r = mulberry32(seed);
  const out = ['', ' ', '\u3000', '\ufeff', 'a', '一', '😀', '\ud83d', '\ude00', 'a b', ' a ', '一 a a'];
  for (let i = 0; i < count; i++) out.push(fuzzText(r, i % 10 === 0 ? 600 : 40));
  return out;
}

describe('wordStats', () => {
  test('counts match the regex implementation on the fuzz corpus', () => {
    for (const s of fuzzStrings(1, 4000)) {
      expect(countCJKAwareWords(s)).toBe(regexCountCJKAwareWords(s));
      expect(isCJKDominant(s)).toBe(regexIsCJKDominant(s));
    }
  });

  test('every code unit is classified as whitespace exactly when /\\s/ matches it', () => {
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      expect(wordStats(ch).nonWhitespace).toBe(/\s/.test(ch) ? 0 : 1);
      expect(wordStats(ch).cjk).toBe(new RegExp(`[${CJK_SLUG_CHARS}]`).test(ch) ? 1 : 0);
    }
  });

  test('concatWordStats(a, b) equals wordStats(a + b)', () => {
    const xs = fuzzStrings(2, 1500);
    const r = mulberry32(3);
    for (let i = 0; i < 6000; i++) {
      const a = xs[Math.floor(r() * xs.length)]!;
      const b = xs[Math.floor(r() * xs.length)]!;
      expect(concatWordStats(wordStats(a), wordStats(b))).toEqual(wordStats(a + b));
      expect(wordCountOf(concatWordStats(wordStats(a), wordStats(b)))).toBe(regexCountCJKAwareWords(a + b));
    }
  });

  test('concatenation folds left over many pieces', () => {
    const xs = fuzzStrings(4, 300);
    let joined = '';
    let st = wordStats('');
    for (const x of xs) {
      joined += x;
      st = concatWordStats(st, wordStats(x));
      expect(wordCountOf(st)).toBe(regexCountCJKAwareWords(joined));
    }
  });
});
