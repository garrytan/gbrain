/**
 * Deterministic mixed-script corpus for the chunker word-count goldens:
 * Latin words, Han / Hiragana / Katakana / Hangul runs, astral emoji and
 * CJK Extension B (surrogate pairs the BMP-only CJK ranges do not count),
 * every JS `\s` whitespace code unit, ASCII and CJK delimiters, and docs
 * whose CJK density sits on either side of CJK_DENSITY_THRESHOLD.
 */

export interface FuzzCase {
  text: string;
  chunkSize: number;
  chunkOverlap: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WHITESPACE = [
  ' ', ' ', ' ', ' ', '\n', '\n\n', '\t', '\r\n', '\v', '\f',
  '\u00a0', '\u1680', '\u2003', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
];
const DELIMS = ['. ', '! ', '? ', '.\n', '; ', ': ', ', ', '。', '！', '？', '；', '：', '，', '、', '.', '3.5'];
const LATIN = ['alpha', 'beta', 'gamma', 'delta', 'x', 'API', 'café', 'naïve', 'Привет', 'שלום', 'http://e.x/a?b=1', '42', 'v0.60'];
const EMOJI = ['😀', '🚀', '👍🏽', '🇯🇵', '❤️', '👨‍👩‍👧'];

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function cjkChar(r: () => number): string {
  const ranges: Array<[number, number]> = [[0x4e00, 0x9fff], [0x3040, 0x309f], [0x30a0, 0x30ff], [0xac00, 0xd7af]];
  const [lo, hi] = pick(r, ranges);
  return String.fromCharCode(lo + Math.floor(r() * (hi - lo + 1)));
}

function cjkRun(r: () => number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += cjkChar(r);
  return s;
}

function token(r: () => number, cjkBias: number): string {
  const x = r();
  if (x < cjkBias) return cjkRun(r, 1 + Math.floor(r() * 12));
  if (x < cjkBias + 0.06) return pick(r, EMOJI);
  if (x < cjkBias + 0.08) return String.fromCodePoint(0x20000 + Math.floor(r() * 0xa6d0));
  if (x < cjkBias + 0.12) return pick(r, DELIMS);
  return pick(r, LATIN);
}

export function fuzzText(r: () => number, maxTokens: number): string {
  const cjkBias = pick(r, [0, 0.05, 0.15, 0.25, 0.3, 0.35, 0.5, 0.8, 1]);
  const n = Math.floor(r() * maxTokens);
  let s = r() < 0.2 ? pick(r, WHITESPACE) : '';
  for (let i = 0; i < n; i++) {
    s += token(r, cjkBias);
    const w = r();
    if (w < 0.55) s += pick(r, WHITESPACE);
    else if (w < 0.6) s += '\n\n';
  }
  return s;
}

export function fuzzCases(seed: number, count: number): FuzzCase[] {
  const r = mulberry32(seed);
  const cases: FuzzCase[] = [];
  for (let i = 0; i < count; i++) {
    const big = r() < 0.15;
    cases.push({
      text: fuzzText(r, big ? 4000 : 400),
      chunkSize: pick(r, [8, 20, 50, 120, 300]),
      chunkOverlap: pick(r, [0, 5, 20, 50]),
    });
  }
  return cases;
}
