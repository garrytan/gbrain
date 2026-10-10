/**
 * capByChars skips the token count when a chunk's UTF-8 byte length already
 * proves it fits the budget (fitsEmbedTokens). That is sound only if the byte
 * length bounds estimateEmbedTokens from above for every string: the fuzz
 * checks the bound directly, and the corpora compare whole chunker outputs
 * with the bound disabled through the test seam (every decision counted).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { __testing, estimateEmbedTokens, estimateTokens, fitsEmbedTokens } from '../../src/core/chunkers/token-estimate.ts';
import { chunkText } from '../../src/core/chunkers/recursive.ts';
import { prepareMarkdownChunks } from '../../src/core/markdown-chunks.ts';

afterEach(() => __testing.setByteBound(true));

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  () => 'granite', () => ' harbor', () => 'API', () => 'v0.60', () => '<|endoftext|>', () => '\n', () => '\n\n', () => '  ', () => '\t',
  () => '。', () => '，', () => '!?', () => '😀', () => '🚀', () => '\u00e9t\u00e9', () => '\u2019', () => '\ufeff', () => '\ud800',
  () => '1234567', () => 'https://example.com/a?b=c', () => '## heading', () => '- item',
];

function fuzzString(r: () => number): string {
  let s = '';
  const len = 1 + Math.floor(r() * 400);
  while (s.length < len) {
    const roll = r();
    if (roll < 0.3) s += String.fromCharCode(0x4e00 + Math.floor(r() * 0x5200));
    else if (roll < 0.4) s += String.fromCharCode(0x3041 + Math.floor(r() * 0xbe));
    else if (roll < 0.45) s += String.fromCharCode(0xac00 + Math.floor(r() * 0x2ba4));
    else s += PIECES[Math.floor(r() * PIECES.length)]!();
  }
  return s;
}

function cjkPage(r: () => number, density: number): string {
  const words = ['gbrain', 'search', 'API', 'v0.60', 'memory', 'note', '😀'];
  let body = '';
  const sentences = 20 + Math.floor(r() * 160);
  for (let s = 0; s < sentences; s++) {
    const len = 5 + Math.floor(r() * 40);
    for (let i = 0; i < len; i++) {
      body += r() < density ? String.fromCharCode((r() < 0.7 ? 0x4e00 : 0x3041) + Math.floor(r() * (r() < 0.7 ? 0x5200 : 0xbe))) : ` ${words[Math.floor(r() * words.length)]} `;
    }
    body += ['。', '！', '？', '. ', '，', '\n', '\n\n'][Math.floor(r() * 7)];
  }
  return body;
}

describe('fitsEmbedTokens', () => {
  test('UTF-8 byte length bounds estimateEmbedTokens and estimateTokens on 5,000 mixed strings', () => {
    const r = rng(6006);
    for (let i = 0; i < 5000; i++) {
      const s = fuzzString(r);
      const bytes = Buffer.byteLength(s, 'utf8');
      expect(estimateEmbedTokens(s)).toBeLessThanOrEqual(bytes);
      expect(estimateTokens(s)).toBeLessThanOrEqual(bytes);
      for (const max of [16, 64, 512, 2000]) {
        if (fitsEmbedTokens(s, max)) expect(estimateEmbedTokens(s)).toBeLessThanOrEqual(max);
      }
    }
  });

  test('vouches exactly when the byte length fits', () => {
    expect(fitsEmbedTokens('a'.repeat(2000), 2000)).toBe(true);
    expect(fitsEmbedTokens('a'.repeat(2001), 2000)).toBe(false);
    expect(fitsEmbedTokens('漢'.repeat(666), 2000)).toBe(true);
    expect(fitsEmbedTokens('漢'.repeat(667), 2000)).toBe(false);
    expect(fitsEmbedTokens('😀'.repeat(500), 2000)).toBe(true);
    expect(fitsEmbedTokens('😀'.repeat(501), 2000)).toBe(false);
  });
});

describe('chunker output is unchanged by the byte bound', () => {
  const both = <T>(fn: () => T): [T, T] => {
    const on = fn();
    __testing.setByteBound(false);
    try { return [on, fn()]; } finally { __testing.setByteBound(true); }
  };

  test('chunkText on CJK pages at three densities and three token budgets', () => {
    const r = rng(75);
    for (let p = 0; p < 45; p++) {
      const text = cjkPage(r, [0.2, 0.5, 0.9][p % 3]!);
      for (const maxTokens of [64, 500, 2000]) {
        const [on, off] = both(() => chunkText(text, { maxTokens }));
        expect(on).toEqual(off);
      }
    }
  });

  test('chunkText on whitespace-less CJK, emoji runs and short maxChars', () => {
    const r = rng(76);
    for (let p = 0; p < 20; p++) {
      const han = Array.from({ length: 500 + Math.floor(r() * 9000) }, () => String.fromCharCode(0x4e00 + Math.floor(r() * 0x5200))).join('');
      const emoji = '😀🚀'.repeat(200 + Math.floor(r() * 2000));
      for (const text of [han, emoji, `${han}\n\n${emoji}`]) {
        for (const opts of [{}, { maxChars: 700 }, { maxTokens: 300 }]) {
          const [on, off] = both(() => chunkText(text, opts));
          expect(on).toEqual(off);
        }
      }
    }
  });

  test('prepareMarkdownChunks on mixed pages', async () => {
    const r = rng(77);
    for (let p = 0; p < 30; p++) {
      const page = { compiled_truth: `# Title ${p}\n\n${cjkPage(r, [0.2, 0.9][p % 2]!)}`, timeline: p % 3 ? '' : cjkPage(r, 0.5) };
      const on = await prepareMarkdownChunks(page);
      __testing.setByteBound(false);
      try {
        expect(on).toEqual(await prepareMarkdownChunks(page));
      } finally {
        __testing.setByteBound(true);
      }
    }
  });
});
