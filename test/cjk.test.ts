import { describe, test, expect } from 'bun:test';
import {
  hasCJK,
  countCJKAwareWords,
  CJK_DENSITY_THRESHOLD,
  CJK_RANGES_REGEX,
  CJK_SLUG_CHARS,
  CJK_SENTENCE_DELIMITERS,
  CJK_CLAUSE_DELIMITERS,
  escapeLikePattern,
} from '../src/core/cjk.ts';

describe('hasCJK', () => {
  test('true on Han', () => {
    expect(hasCJK('品牌圣经')).toBe(true);
  });
  test('true on Hiragana', () => {
    expect(hasCJK('ひらがな')).toBe(true);
  });
  test('true on Katakana', () => {
    expect(hasCJK('カタカナ')).toBe(true);
  });
  test('true on Hangul Syllables', () => {
    expect(hasCJK('한글')).toBe(true);
  });
  test('false on ASCII', () => {
    expect(hasCJK('hello world')).toBe(false);
  });
  test('false on Latin-with-accents', () => {
    expect(hasCJK('café résumé')).toBe(false);
  });
  test('true on mixed CJK + ASCII', () => {
    expect(hasCJK('hello 世界')).toBe(true);
  });
  test('false on empty string', () => {
    expect(hasCJK('')).toBe(false);
  });
});

describe('countCJKAwareWords (30% density threshold)', () => {
  test('pure Chinese paragraph counts chars', () => {
    // 6 Han characters, all CJK → char count
    expect(countCJKAwareWords('品牌圣经测试用例')).toBe(8);
  });

  test('pure ASCII paragraph counts whitespace tokens', () => {
    expect(countCJKAwareWords('this is a normal english sentence')).toBe(6);
  });

  test('CJK-dominant mixed switches to char count', () => {
    // ~80% CJK by char count → char-count branch
    const s = '品牌圣经品牌圣经 is the brand';
    expect(countCJKAwareWords(s)).toBe(s.replace(/\s/g, '').length);
  });

  test('English doc with one Japanese term stays whitespace-tokenized', () => {
    // 1 CJK / ~50 non-whitespace chars = ~2%, well below 30%
    const s = 'the user wrote a long english blog post about マンガ and other interests';
    // Should NOT char-count (would be ~60). Should whitespace-tokenize.
    expect(countCJKAwareWords(s)).toBe((s.match(/\S+/g) || []).length);
  });

  test('exactly at 30% threshold uses CJK branch', () => {
    // 3 CJK chars + 7 ASCII non-ws chars = 10 total; 3/10 = 0.30 → CJK
    const s = '世界世 abcdefg';
    expect(countCJKAwareWords(s)).toBe(10);
  });

  test('just below threshold uses whitespace branch', () => {
    // 2 CJK + 8 ASCII = 10 total; 2/10 = 0.20 < 0.30 → whitespace
    const s = '世界 abcdefgh';
    expect(countCJKAwareWords(s)).toBe(2); // two whitespace-delimited tokens
  });

  test('empty string returns 0', () => {
    expect(countCJKAwareWords('')).toBe(0);
  });

  test('whitespace-only returns 0', () => {
    expect(countCJKAwareWords('   \n\t  ')).toBe(0);
  });
});

describe('constants', () => {
  test('CJK_DENSITY_THRESHOLD is 0.30', () => {
    expect(CJK_DENSITY_THRESHOLD).toBe(0.30);
  });

  test('CJK_RANGES_REGEX matches all four scripts', () => {
    expect(CJK_RANGES_REGEX.test('一')).toBe(true);
    expect(CJK_RANGES_REGEX.test('あ')).toBe(true);
    expect(CJK_RANGES_REGEX.test('カ')).toBe(true);
    expect(CJK_RANGES_REGEX.test('한')).toBe(true);
    expect(CJK_RANGES_REGEX.test('a')).toBe(false);
  });

  test('CJK_SLUG_CHARS can be embedded into a character class', () => {
    const re = new RegExp(`^[a-z0-9${CJK_SLUG_CHARS}]+$`);
    expect(re.test('品牌圣经')).toBe(true);
    expect(re.test('hello')).toBe(true);
    expect(re.test('hello-world')).toBe(false); // no hyphen in this test class
  });

  test('CJK_SENTENCE_DELIMITERS covers 。！？', () => {
    expect(CJK_SENTENCE_DELIMITERS).toEqual(['。', '！', '？']);
  });

  test('CJK_CLAUSE_DELIMITERS covers ；：，、', () => {
    expect(CJK_CLAUSE_DELIMITERS).toEqual(['；', '：', '，', '、']);
  });
});

describe('escapeLikePattern', () => {
  test('escapes % and _', () => {
    expect(escapeLikePattern('100% off_today')).toBe('100\\% off\\_today');
  });
  test('escapes backslash first', () => {
    // 'a\b' → 'a\\b' (backslash doubled)
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });
  test('escapes all three meta-chars together', () => {
    expect(escapeLikePattern('a\\%b_c')).toBe('a\\\\\\%b\\_c');
  });
  test('no-op on plain text', () => {
    expect(escapeLikePattern('hello world')).toBe('hello world');
  });
  test('no-op on CJK', () => {
    expect(escapeLikePattern('测试')).toBe('测试');
  });
});
