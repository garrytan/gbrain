/**
 * estimateTokens counts ASCII text by memoized cl100k pre-tokens instead of
 * one whole-text WASM encode. Both paths must give the exact same count, and
 * so the same chunk boundaries, for every input: the fuzz compares the counts
 * directly, the fixtures compare whole chunker outputs with the reference
 * (whole-text encode) path forced through the test seam.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { __testing, estimateEmbedTokens, estimateTokens } from '../../src/core/chunkers/token-estimate.ts';
import { chunkText } from '../../src/core/chunkers/recursive.ts';
import { chunkCodeText } from '../../src/core/chunkers/code.ts';
import { prepareMarkdownChunks } from '../../src/core/markdown-chunks.ts';

afterEach(() => __testing.setPieceCounting(true));

function reference<T>(fn: () => T): T {
  __testing.setPieceCounting(false);
  try {
    return fn();
  } finally {
    __testing.setPieceCounting(true);
  }
}

async function referenceAsync<T>(fn: () => Promise<T>): Promise<T> {
  __testing.setPieceCounting(false);
  try {
    return await fn();
  } finally {
    __testing.setPieceCounting(true);
  }
}

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

const ALPHABET = [
  'the', 'The', ' quick', 'BROWN', 'fox', 'a', 'Z', 'x', ' ', ' ', '  ', '   ', '\n', '\n', '\n\n', '\r\n', '\r', '\t', '\v', '\f',
  "'s", "'S", "'t", "'re", "'RE", "'Ve", "'m", "'ll", "'lL", "'d", "'", "'x", '1', '12', '1234567', '0', '.', ',', '!', '?', '-', '--',
  '...', '()', '{', '}', '[', ']', '#', '##', '* ', '- ', '`', '```', '|', '/', '\\', '_', 'snake_case', 'http://', '.com', '=', '+',
  '\u0000', '\u001f', '\u007f', '<|endoftext|>', '<|fim_prefix|>', '<|', '|>', 'é', 'café', '\u0301', '\u00a0', '\u0085', '\ufeff',
  '\u2014', '\u2019', '\u201c', '中文', '日本語', '한국어', '。', '，', '😀', '👍🏽', '𝔸', 'ſ', '\u212a', '٣', 'ｆｕｌｌ', '\ud800', '\udc00',
  '\u2028', '\u3000', 'ß', 'İ',
];

function randomText(r: () => number, maxPieces: number): string {
  const n = Math.floor(r() * maxPieces);
  let s = '';
  for (let k = 0; k < n; k++) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return s;
}

function asciiText(r: () => number, maxPieces: number): string {
  let s = '';
  const n = Math.floor(r() * maxPieces);
  for (let k = 0; k < n; k++) s += String.fromCharCode(Math.floor(r() * 128));
  return s;
}

describe('estimateTokens piece counting equals the whole-text encode', () => {
  test('reference path is the raw cl100k encoder', () => {
    const { get_encoding } = require('@dqbd/tiktoken');
    const enc = get_encoding('cl100k_base');
    try {
      for (const s of ['hello world', "it's 2026, isn't it?\n\nNext line", 'naïve café 中文 😀', '  \n\t x']) {
        expect(reference(() => estimateTokens(s))).toBe(enc.encode(s).length);
      }
    } finally {
      enc.free();
    }
  });

  test('fuzz: biased markdown-ish alphabet incl. non-ASCII and special-token text', () => {
    const r = rng(4242);
    for (let k = 0; k < 10_000; k++) {
      const s = randomText(r, 60);
      const expected = reference(() => estimateTokens(s));
      if (estimateTokens(s) !== expected) throw new Error(`count mismatch on ${JSON.stringify(s)}`);
    }
  });

  test('fuzz: every ASCII code point', () => {
    const r = rng(7);
    for (let k = 0; k < 8_000; k++) {
      const s = asciiText(r, 80);
      const expected = reference(() => estimateTokens(s));
      if (estimateTokens(s) !== expected) throw new Error(`count mismatch on ${JSON.stringify(s)}`);
    }
  });

  test('long pre-tokens beyond the memo length and repeated calls stay exact', () => {
    const inputs = ['a'.repeat(5_000), ' '.repeat(300) + 'x', '-'.repeat(1_000) + '\n' + 'b'.repeat(70), `${'word '.repeat(2_000)}\n${'9'.repeat(400)}`];
    for (let pass = 0; pass < 2; pass++) {
      for (const s of inputs) expect(estimateTokens(s)).toBe(reference(() => estimateTokens(s)));
    }
  });
});

const PROSE = Array.from({ length: 900 }, (_, i) => ['alpha', "isn't", 'beta,', 'gamma.', 'Delta', '42', '(note)', 'https://example.com/a?b=c'][i % 8]).join(' ');
const CJK = '中文段落内容测试，这是一个很长的句子。'.repeat(400);
const KOREAN_URLS = Array.from({ length: 200 }, (_, i) => `설정 항목 ${i}: https://example.com/path/${i}?q=값 참조`).join(' ');
const DENSE_JSON = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, url: `https://ex.io/${i}/x?y=${i * 7}`, tag: `t${i}` })));
const NEAR_LIMIT = 'x1y2z3'.repeat(999) + ' tail';

const MARKDOWN_PAGE = [
  '# Title',
  '',
  PROSE,
  '',
  '```ts',
  Array.from({ length: 120 }, (_, i) => `export function f${i}(a: number): number { return a * ${i}; } // ${'c'.repeat(i % 40)}`).join('\n'),
  '```',
  '',
  'Curly quotes \u201cmixed\u201d \u2014 em dash, caf\u00e9, 😀 emoji.',
  CJK.slice(0, 3_000),
  '',
  '~~~py',
  Array.from({ length: 80 }, (_, i) => `def g${i}(x):\n    return x + ${i}`).join('\n'),
  '~~~',
  '',
  DENSE_JSON.slice(0, 7_000),
].join('\n');

describe('chunkers produce identical chunks with piece counting', () => {
  const texts = { PROSE, CJK, KOREAN_URLS, DENSE_JSON, NEAR_LIMIT, MARKDOWN_PAGE };

  test('chunkText: chunk text, order and token counts', () => {
    for (const [name, text] of Object.entries(texts)) {
      for (const maxTokens of [undefined, 512]) {
        const actual = chunkText(text, { maxTokens });
        const expected = reference(() => chunkText(text, { maxTokens }));
        expect({ name, maxTokens, chunks: actual }).toEqual({ name, maxTokens, chunks: expected });
        expect(actual.length).toBeGreaterThan(0);
        for (const c of actual) {
          expect(estimateTokens(c.text)).toBe(reference(() => estimateTokens(c.text)));
          expect(estimateEmbedTokens(c.text)).toBe(reference(() => estimateEmbedTokens(c.text)));
        }
      }
    }
  });

  test('prepareMarkdownChunks: truth, timeline and fenced code chunks', async () => {
    const page = { compiled_truth: MARKDOWN_PAGE, timeline: `- 2026-01-01: ${PROSE.slice(0, 2_500)}`, frontmatter: {} };
    for (const maxTokens of [undefined, 512]) {
      const actual = await prepareMarkdownChunks(page, maxTokens);
      const expected = await referenceAsync(() => prepareMarkdownChunks(page, maxTokens));
      expect(actual).toEqual(expected);
      expect(actual.some((c) => c.chunk_source === 'fenced_code')).toBe(true);
    }
  });

  test('chunkCodeText: symbol chunks and oversize caps', async () => {
    const source = Array.from({ length: 60 }, (_, i) => `export function h${i}(): string {\n  return ${JSON.stringify(KOREAN_URLS.slice(i * 40, i * 40 + 400))};\n}`).join('\n\n');
    const actual = await chunkCodeText(source, 'fixture.ts');
    const expected = await referenceAsync(() => chunkCodeText(source, 'fixture.ts'));
    expect(actual).toEqual(expected);
  });
});
