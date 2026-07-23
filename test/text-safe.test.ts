/**
 * Unit tests for src/core/text-safe.ts — UTF-16 surrogate-safe helpers.
 *
 * Covers all 3 surrogate cases (high+low pair straddle, stray high,
 * AT-low) plus boundary-after-pair (codex CK16 regression evidence).
 *
 * `truncateUtf8` regressions live here AND in
 * `test/eval-contradictions-judge.test.ts` (which imports it through
 * judge.ts re-export, proving the move is byte-equivalent).
 */

import { describe, test, expect } from 'bun:test';
import { truncateUtf8, safeSplitIndex, ensureWellFormed } from '../src/core/text-safe.ts';

// 🚀 = U+1F680 (surrogate pair: 0xD83D 0xDE80; JS string length = 2).
// 𝕏 = U+1D54F (surrogate pair: 0xD835 0xDD4F; JS string length = 2).
// 𠀀 = U+20000 (non-BMP CJK: 0xD840 0xDC00; JS string length = 2).
const ROCKET = '🚀';   // 🚀
const MATH_X = '𝕏';   // 𝕏
const NBMP_HAN = '𠀀'; // 𠀀
const STRAY_HIGH = '\uD83D';     // orphaned high surrogate (invalid alone)
const STRAY_LOW = '\uDE80';      // orphaned low surrogate (invalid alone)
const REPLACEMENT = '�';    // U+FFFD, what toWellFormed() substitutes

describe('truncateUtf8', () => {
  test('returns empty for empty input', () => {
    expect(truncateUtf8('', 100)).toBe('');
  });

  test('returns unchanged when already under limit', () => {
    expect(truncateUtf8('short', 100)).toBe('short');
  });

  test('truncates at ASCII boundary', () => {
    expect(truncateUtf8('hello world', 5)).toBe('hello');
  });

  test('case 1: pair straddles cut — drops both halves', () => {
    // text="a🚀b" (length 4: ['a', 0xD83D, 0xDE80, 'b']). Cut at maxChars=2
    // would split between 0xD83D and 0xDE80. Expect "a" (length 1).
    const out = truncateUtf8('a' + ROCKET + 'b', 2);
    expect(out).toBe('a');
  });

  test('case 2: stray high surrogate at end-1 — drops it', () => {
    // text="ab<HIGH>cd". Cut at maxChars=3 lands ON the high; unitBefore
    // is 'b' (regular). Cut at maxChars=4 lands on 'c'; unitBefore is
    // the high surrogate AND unitAtEnd is 'c' (not low) → stray high
    // case. Expect "ab".
    const text = 'ab' + STRAY_HIGH + 'cd';
    const out = truncateUtf8(text, 3); // index 3 → unitBefore=HIGH, unitAtEnd='c'
    expect(out).toBe('ab');
  });

  test('case 3: low surrogate at end-1 — backs up two (intentionally conservative)', () => {
    // text="ab🚀cd" (length 6). Cut at maxChars=4: unitBefore=0xDE80 (low),
    // unitAtEnd='c'. Case 3 fires → end = 4-2 = 2. Expect "ab".
    // Note: pair was COMPLETE in kept half at [2,3]; conservative back-up
    // drops it. Intentional — matches truncateUtf8's pre-extraction behavior
    // verbatim. See safeSplitIndex doc for rationale.
    const text = 'ab' + ROCKET + 'cd';
    const out = truncateUtf8(text, 4);
    expect(out).toBe('ab');
  });

  test('non-BMP CJK pair behaves identically to emoji', () => {
    const text = 'x' + NBMP_HAN + 'y';
    expect(truncateUtf8(text, 2)).toBe('x'); // case 1: cut splits the pair
  });

  test('multiple consecutive pairs preserved when cut is past them', () => {
    const text = ROCKET + MATH_X + 'tail';
    // Cut at maxChars=10 ≥ length=8 → returns full text.
    expect(truncateUtf8(text, 10)).toBe(text);
  });
});

describe('ensureWellFormed (#2011)', () => {
  test('lone high surrogate → U+FFFD', () => {
    const out = ensureWellFormed('before' + STRAY_HIGH + 'after');
    expect(out).toBe('before' + REPLACEMENT + 'after');
    expect(out.isWellFormed()).toBe(true);
  });

  test('lone low surrogate → U+FFFD', () => {
    const out = ensureWellFormed('before' + STRAY_LOW + 'after');
    expect(out).toBe('before' + REPLACEMENT + 'after');
    expect(out.isWellFormed()).toBe(true);
  });

  test('consecutive lone low surrogates → both replaced (the case the old regex got wrong)', () => {
    // The prior hand-rolled two-pass regex produced "�\uDE80" here (the second
    // lookbehind consumed the just-inserted boundary, leaving the 2nd low
    // surrogate orphaned). The built-in replaces both → "��".
    const out = ensureWellFormed(STRAY_LOW + STRAY_LOW);
    expect(out).toBe(REPLACEMENT + REPLACEMENT);
    expect(out.isWellFormed()).toBe(true);
  });

  test('consecutive lone high surrogates → both replaced', () => {
    const out = ensureWellFormed(STRAY_HIGH + STRAY_HIGH);
    expect(out).toBe(REPLACEMENT + REPLACEMENT);
    expect(out.isWellFormed()).toBe(true);
  });

  test('valid pairs (emoji / math / non-BMP CJK) preserved unchanged', () => {
    const text = 'a' + ROCKET + 'b' + MATH_X + 'c' + NBMP_HAN + 'd';
    expect(ensureWellFormed(text)).toBe(text);
    expect(ensureWellFormed(text).isWellFormed()).toBe(true);
  });

  test('clean ASCII / empty input returns an equal well-formed value', () => {
    expect(ensureWellFormed('plain text')).toBe('plain text');
    expect(ensureWellFormed('')).toBe('');
  });

  test('mixed valid pair + lone half: pair kept, orphan replaced', () => {
    // Valid 🚀 then a stray high then text.
    const out = ensureWellFormed(ROCKET + STRAY_HIGH + 'x');
    expect(out).toBe(ROCKET + REPLACEMENT + 'x');
    expect(out.isWellFormed()).toBe(true);
  });

  test('output is JSON-serializable without orphaned escapes', () => {
    // The #2011 failure was Postgres ::jsonb rejecting a lone surrogate.
    // After ensureWellFormed, a JSON round-trip preserves the value.
    const out = ensureWellFormed('emoji ' + STRAY_HIGH + ' tail');
    expect(JSON.parse(JSON.stringify(out))).toBe(out);
    expect(out.isWellFormed()).toBe(true);
  });
});

describe('safeSplitIndex', () => {
  test('maxChars ≤ 0 returns 0', () => {
    expect(safeSplitIndex('any', 0)).toBe(0);
    expect(safeSplitIndex('any', -5)).toBe(0);
  });

  test('maxChars ≥ text.length returns text.length', () => {
    expect(safeSplitIndex('abc', 3)).toBe(3);
    expect(safeSplitIndex('abc', 100)).toBe(3);
  });

  test('maxChars in middle of ASCII text returns maxChars unchanged', () => {
    expect(safeSplitIndex('hello world', 5)).toBe(5);
  });

  test('case 1: pair straddles cut → returns maxChars-1', () => {
    // text="a🚀b" (length 4). maxChars=2: unitBefore=0xD83D, unitAtEnd=0xDE80.
    expect(safeSplitIndex('a' + ROCKET + 'b', 2)).toBe(1);
  });

  test('case 2: stray high surrogate at maxChars-1 → returns maxChars-1', () => {
    // text="ab<HIGH>cd". maxChars=3: unitBefore=HIGH, unitAtEnd='c'.
    const text = 'ab' + STRAY_HIGH + 'cd';
    expect(safeSplitIndex(text, 3)).toBe(2);
  });

  test('case 3: low at maxChars-1 → returns maxChars-2 (conservative)', () => {
    // text="ab🚀cd" (length 6). maxChars=4: unitBefore=0xDE80 (low), unitAtEnd='c'.
    // Pair COMPLETE in kept half; back-up is intentional per truncateUtf8 parity.
    expect(safeSplitIndex('ab' + ROCKET + 'cd', 4)).toBe(2);
  });

  test('boundary-immediately-after-pair returns maxChars-2 (codex CK16 documented)', () => {
    // Codex flagged this as "safe but overly conservative." We test the
    // CURRENT conservative behavior so any future change is intentional.
    // text="hello🚀" (length 7). maxChars=7 ≥ length → returns 7 (full).
    // text="hello🚀x" (length 8). maxChars=7: unitBefore=0xDE80 (low), unitAtEnd='x'.
    // Case 3 fires → returns 5. Documents the conservative back-up.
    const text = 'hello' + ROCKET + 'x'; // length 8
    expect(safeSplitIndex(text, 7)).toBe(5);
  });

  test('determinism: same input → same output across 100 calls', () => {
    const text = 'lorem ' + ROCKET + ' ipsum ' + MATH_X + ' dolor ' + NBMP_HAN;
    const refs = new Set<number>();
    for (let i = 0; i < 100; i++) refs.add(safeSplitIndex(text, 12));
    expect(refs.size).toBe(1);
  });

  test('empty text returns 0', () => {
    expect(safeSplitIndex('', 5)).toBe(0);
  });

  test('truncateUtf8 and safeSplitIndex agree on slice length', () => {
    // Property check: truncateUtf8(text, n).length === safeSplitIndex(text, n)
    // (modulo the empty-string early return which both treat identically).
    const cases: Array<[string, number]> = [
      ['hello world', 5],
      ['a' + ROCKET + 'b', 2],
      ['ab' + STRAY_HIGH + 'cd', 3],
      ['ab' + ROCKET + 'cd', 4],
      ['hello' + ROCKET + 'x', 7],
    ];
    for (const [text, n] of cases) {
      expect(truncateUtf8(text, n).length).toBe(safeSplitIndex(text, n));
    }
  });
});
