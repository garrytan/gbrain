/**
 * maskRanges (link extraction) and tokenizeForScan (mention scan) give the
 * same output as the implementations they replaced, byte for byte.
 *
 * Authoring gate:
 * 1. Protects: link refs and mention matches read the masked text and the
 *    scan tokens (text, offset, length); a different byte moves or drops a
 *    link or a mention on every engine.
 * 2. Fails when: a rewrite masks one code unit too many or too few, mishandles
 *    overlapping/out-of-range ranges, or tokenizes a combining mark, a
 *    surrogate, a CJK character or NFD text differently from the old walk.
 * 3. Existing coverage (by-mention*.test.ts, link-extraction*.test.ts) pins
 *    hand-picked mentions and refs, not the helpers' exact output over
 *    thousands of mixed-script inputs.
 * 4. Seam: none. maskRanges lives in its own internal module (not a published subpath).
 *
 * The reference implementations below are verbatim copies of the replaced
 * code. The last test checks the fixture tells a broken variant apart.
 */
import { describe, expect, it } from 'bun:test';
import { CJK_SLUG_CHARS } from '../src/core/cjk.ts';
import { tokenizeForScan } from '../src/core/by-mention.ts';
import { maskRanges } from '../src/core/mask-ranges.ts';

type Range = [number, number];
interface Tok { text: string; offset: number; length: number }

// ---- reference: maskRanges as it was ----
function referenceMask(content: string, ranges: Range[]): string {
  if (ranges.length === 0) return content;
  const chars = content.split('');
  for (const [s, e] of ranges) {
    for (let i = s; i < e && i < chars.length; i++) chars[i] = ' ';
  }
  return chars.join('');
}

// ---- reference: tokenizeForScan as it was ----
const REF_CJK_RE = new RegExp(`^[${CJK_SLUG_CHARS}]$`, 'u');
const REF_TOKEN_RE = new RegExp(`(?![${CJK_SLUG_CHARS}])[\\p{L}0-9](?:(?![${CJK_SLUG_CHARS}])[\\p{L}\\p{M}0-9])*`, 'gu');
const refNorm = (s: string) => s.normalize('NFC').toLowerCase();
function referenceTokenize(text: string, norm = refNorm): Tok[] {
  const out: Tok[] = [];
  REF_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const spans: Array<{ start: number; end: number }> = [];
  while ((m = REF_TOKEN_RE.exec(text)) !== null) spans.push({ start: m.index, end: m.index + m[0].length });
  let k = 0;
  for (let i = 0; i < text.length;) {
    while (k < spans.length && spans[k]!.end <= i) k++;
    if (k < spans.length && i >= spans[k]!.start && i < spans[k]!.end) {
      const token = text.slice(spans[k]!.start, spans[k]!.end);
      out.push({ text: norm(token), offset: spans[k]!.start, length: token.length });
      i = spans[k]!.end;
      k++;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + len);
    if (REF_CJK_RE.test(ch)) { out.push({ text: norm(ch), offset: i, length: len }); i += len; } else i++;
  }
  return out;
}

// ---- seeded fixture ----
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PIECES = [
  'Acme', 'ACME Corp', 'acme', "Acme's", 'jordan-lee', 'x1', '42', '½', '¹', '١٢', 'ǅ', 'İstanbul', 'Straße', 'ﬁle',
  'Nguyễn', 'Nguye\u0302\u0303n', 'Zoë', 'Zoe\u0308', 'e\u0301', '\u0301', '\u0300\u0301', 'Ελένη', 'ΣΊΣΥΦΟΣ', 'Москва', 'שלום', 'مرحبا', 'हिन्दी', 'ไทย',
  '김지원', '김 지원', '지원씨는', 'タナカ', 'デン・カフェ', 'ー', '\u3099', 'ﾀﾅｶ', '王伟', '中文字', 'ひらがな', '㐀', '𠀀', '𝐀𝐁', '𝒳',
  '❤\ufe0f', '😀', '👩\u200d💻', '\ufe0f', '\u200b', '\ud800', '\udc00', '\udbff\udfff',
  ' ', ' ', ' ', '\t', '\n', '\r\n', '\r', '\u00a0', '\u3000', '.', ',', "'", '@', '#', '-', '_', '/', '[[people/a]]', '`code`', '```', '<!--', '-->',
];
function fixtureTexts(): string[] {
  const rand = rng(1);
  const texts: string[] = ['', ' ', 'a', '\ud800', 'e\u0301', '王', '😀'];
  for (let i = 0; i < 4000; i++) {
    const n = Math.floor(rand() * 60);
    let t = '';
    for (let k = 0; k < n; k++) t += PIECES[Math.floor(rand() * PIECES.length)]! + (rand() < 0.5 ? ' ' : '');
    texts.push(t);
  }
  // One very long line (no newline) and a long CRLF page.
  texts.push(Array.from({ length: 20000 }, (_, k) => PIECES[k % PIECES.length]).join(''));
  texts.push(Array.from({ length: 5000 }, (_, k) => `Line ${k} mentions Acme Corp and 김지원\r\n`).join(''));
  return texts;
}
function fixtureRanges(texts: string[]): Array<[string, Range[]]> {
  const rand = rng(2);
  return texts.map(t => {
    const len = t.length;
    const n = Math.floor(rand() * 6);
    const ranges: Range[] = [];
    for (let k = 0; k < n; k++) {
      const s = Math.floor(rand() * (len + 6)) - 3;
      const e = rand() < 0.15 ? s - 1 : s + Math.floor(rand() * 12);
      ranges.push([s, e]);
      if (rand() < 0.2) ranges.push([e, e + 3]); // adjacent
      if (rand() < 0.2) ranges.push([s + 1, e + 2]); // overlapping
    }
    if (rand() < 0.1) ranges.push([0, len]);
    if (rand() < 0.1) ranges.push([len - 1, len + 5]);
    return [t, ranges];
  });
}
const TEXTS = fixtureTexts();
const MASK_INPUTS = fixtureRanges(TEXTS);

function firstMismatch<T>(inputs: T[], a: (x: T) => unknown, b: (x: T) => unknown): T | undefined {
  for (const x of inputs) if (JSON.stringify(a(x)) !== JSON.stringify(b(x))) return x;
  return undefined;
}

describe('maskRanges keeps the replaced output', () => {
  it('edge cases', () => {
    const t = 'ab😀c\r\nd王e\u0301';
    const cases: Array<[string, Range[]]> = [
      ['', []], ['', [[0, 3]]], [t, []], [t, [[0, 0]]], [t, [[3, 2]]], [t, [[-4, 2]]], [t, [[-4, -1]]],
      [t, [[0, t.length]]], [t, [[t.length - 1, t.length + 9]]], [t, [[t.length, t.length + 2]]],
      [t, [[1, 4], [2, 6]]], [t, [[1, 3], [3, 5]]], [t, [[5, 7], [0, 2]]], [t, [[2, 3]]], [t, [[3, 4]]],
      [t, [[1, 4], [1, 4]]], [t, [[0, 1], [t.length - 1, t.length]]], ['[[src:a/b]] then [[c/d]]', [[0, 11]]],
    ];
    for (const [s, r] of cases) expect(maskRanges(s, r)).toBe(referenceMask(s, r));
  });

  it(`a seeded fixture of ${MASK_INPUTS.length} texts with random, overlapping, adjacent and out-of-range ranges`, () => {
    expect(firstMismatch(MASK_INPUTS, ([s, r]) => maskRanges(s, r), ([s, r]) => referenceMask(s, r))).toBeUndefined();
  });
});

describe('tokenizeForScan keeps the replaced output', () => {
  it('edge cases', () => {
    const cases = ['', ' ', '\ud800', '\udc00x', 'x\ud800y', '\u0301abc', 'abc\u0301', '😀abc', '❤\ufe0f Health Notes', 'Nguye\u0302\u0303n Văn',
      'a1½b', '김지원씨는', 'デン・カフェ', 'ﾀﾅｶ', '王伟and李', '𠀀𝐀x', 'İ', 'ǅx', "Acme's", '\r\nA\rB\nC', 'x'.repeat(100000),
      // Supplementary-plane letters as word lead and continuation, Han Ext-B runs (not CJK here), contextual lowercase.
      '𝐀bc', 'ab𝐀', 'a𝐀b𝒳c', '𠀀𠀁𠀂', 'x𠀀y', '𠀀王', 'ΟΔΟΣ', 'ΣΊΣΥΦΟΣ ΟΔΟΣ.', '\ud835x', 'x\udc00\ud835'];
    for (const s of cases) expect(tokenizeForScan(s)).toEqual(referenceTokenize(s));
  });

  it(`a seeded fixture of ${TEXTS.length} mixed-script texts`, () => {
    expect(firstMismatch(TEXTS, tokenizeForScan, t => referenceTokenize(t))).toBeUndefined();
  });
});

describe('the fixture tells a broken rewrite apart', () => {
  it('catches a mask that stops one code unit early, a tokenizer that skips NFC and one that splits supplementary letters', () => {
    const shortMask = (s: string, r: Range[]) => referenceMask(s, r.map(([a, b]) => [a, b - 1] as Range));
    expect(firstMismatch(MASK_INPUTS, ([s, r]) => shortMask(s, r), ([s, r]) => referenceMask(s, r))).toBeDefined();
    const noNfc = (t: string) => referenceTokenize(t, s => s.toLowerCase());
    expect(firstMismatch(TEXTS, noNfc, t => referenceTokenize(t))).toBeDefined();
    // A rewrite that loses the tokens that start with a supplementary-plane letter.
    const bmpOnly = (t: string) => referenceTokenize(t).filter(k => (k.text.codePointAt(0) ?? 0) <= 0xffff);
    expect(firstMismatch(TEXTS, bmpOnly, t => referenceTokenize(t))).toBeDefined();
  });
});
