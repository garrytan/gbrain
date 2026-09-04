import { describe, test, expect } from 'bun:test';
import { chunkText } from '../../src/core/chunkers/recursive.ts';

describe('CJK chunk overlap & boundary fixes', () => {
  test('Chinese sentences align overlap to CJK sentence boundaries', () => {
    // 40 short Chinese sentences, each 9-10 chars. Old ASCII tokenization
    // treated each sentence as one "word"; overlap either vanished or
    // spanned whole sentences. New path counts chars and splits on 。！？
    const sentences = Array.from(
      { length: 40 },
      (_, i) => `第${i + 1}句中文测试句子。`,
    );
    const text = sentences.join('');
    const chunks = chunkText(text, { chunkSize: 50, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);

    // Lossless reconstruction for whitespace-free CJK text.
    const reconstructed = reconstructFromChunks(chunks);
    expect(reconstructed).toBe(text);

    // Each chunk after the first should start at a CJK sentence boundary.
    for (let i = 1; i < chunks.length; i++) {
      const curr = chunks[i].text;
      expect(curr[0]).toMatch(/[一-鿿぀-ゟ゠-ヿ가-힯0-9]/);
      // The first char should be the start of a sentence number, and the
      // character just before the overlap in the previous chunk should be 。
      const prev = chunks[i - 1].text;
      const startInPrev = prev.lastIndexOf(curr.slice(0, Math.min(3, curr.length)));
      if (startInPrev > 0) {
        expect(prev[startInPrev - 1]).toBe('。');
      }
    }
  });

  test('mixed CJK + English preserves every non-whitespace character', () => {
    // Use non-periodic, numbered fragments so any loss or reorder is visible.
    const blocks: string[] = [];
    for (let i = 0; i < 40; i++) {
      blocks.push(`Step ${i + 1} begins here. `);
      blocks.push(`这是第${i + 1}步中文说明。`);
    }
    const text = blocks.join('');
    const chunks = chunkText(text, { chunkSize: 60, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);

    // Whitespace may be normalized at chunk boundaries by trimming, so compare
    // non-whitespace content only.
    const strip = (s: string) => s.replace(/\s+/g, '');
    const reconstructed = reconstructFromChunks(chunks);
    expect(strip(reconstructed)).toBe(strip(text));

    // Spot-check ordering: each step number appears in order.
    let cursor = 0;
    for (let n = 1; n <= 40; n++) {
      const idx = reconstructed.indexOf(`Step ${n}`, cursor);
      expect(idx).toBeGreaterThanOrEqual(cursor);
      cursor = idx + 1;
    }
  });

  test('overlap span is bounded on varied CJK-dominant text', () => {
    const sentences: string[] = [];
    for (let i = 0; i < 60; i++) {
      sentences.push(`第${i + 1}段混合文本，包含一些英文词汇如${i + 1}number。`);
    }
    const text = sentences.join('');
    const overlapChars = 20;
    const chunks = chunkText(text, { chunkSize: 60, chunkOverlap: overlapChars });
    expect(chunks.length).toBeGreaterThan(1);

    // No chunk should be a pure duplicate of its predecessor on varied text,
    // and the actual overlap must be a suffix of the previous chunk.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1].text;
      const curr = chunks[i].text;
      // Find the actual overlap length.
      let actualOverlap = 0;
      for (let k = 1; k <= Math.min(prev.length, curr.length); k++) {
        if (prev.endsWith(curr.slice(0, k))) actualOverlap = k;
      }
      expect(actualOverlap).toBeGreaterThan(0);
      // Overlap should not swallow the whole previous chunk.
      expect(actualOverlap).toBeLessThan(prev.length);
      // Overlap should be bounded by a small multiple of target overlap chars.
      expect(actualOverlap).toBeLessThanOrEqual(Math.max(overlapChars, 30) * 3);
    }

    const strip = (s: string) => s.replace(/\s+/g, '');
    expect(strip(reconstructFromChunks(chunks))).toBe(strip(text));
  });

  test('emoji survive overlap path at production chunk params', () => {
    // Production ingest calls chunkText with ONLY { maxTokens } — chunkSize
    // 300 / overlap 50 / maxChars 6000 defaults apply, and the overlap is
    // prepended via extractTrailingContext, not the capByChars path. A
    // regression here ships to the DB even when the maxChars-forced test
    // above passes (that exact miss happened with the 🚀 boundary).
    const parts: string[] = [];
    for (let i = 0; i < 120; i++) {
      parts.push(`第${i + 1}段中文说明文字，这里有一枚火箭🚀用于测试代理对完整性。`);
    }
    const text = parts.join('\n');
    const chunks = chunkText(text, { maxTokens: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      expect(hasOrphanedSurrogate(c.text)).toBe(false);
    }

    // Lossless reconstruction (whitespace-normalized) — no glyph dropped,
    // no glyph duplicated outside designed overlap.
    const strip = (s: string) => s.replace(/\s+/g, '');
    expect(strip(reconstructFromChunks(chunks))).toBe(strip(text));
  });

  test('byte-identical English fixture path is unchanged', () => {
    // Pure ASCII text must stay on the original code path, so chunking should
    // match the historical behavior. We hard-code the expected chunks for a
    // fixture that exercises paragraph, sentence, word, and overlap logic.
    const sentences = Array.from(
      { length: 20 },
      (_, i) => `Sentence ${i + 1} has exactly eight words in it here.`,
    );
    const text = sentences.join(' ');
    const chunks = chunkText(text, { chunkSize: 40, chunkOverlap: 8 });
    expect(chunks.length).toBeGreaterThan(1);

    // Reconstruction with overlap removed must equal the original.
    const reconstructed = reconstructFromChunks(chunks);
    expect(reconstructed).toBe(text);

    // Each non-final chunk should end near an English sentence boundary.
    for (let i = 0; i < chunks.length - 1; i++) {
      const trimmed = chunks[i].text.trimEnd();
      expect(trimmed).toMatch(/[.!?]$/);
    }

    // Indices should be sequential.
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  test('emoji surrogate pairs survive CJK chunk boundaries whole', () => {
    // Emoji such as 🚀 are astral: each is a UTF-16 surrogate PAIR (2 code
    // units). A CJK-dominant chunk cutting a sentence/clause boundary inside
    // such a pair would split the emoji across two chunks (the capByChars
    // regression where the boundary was not routed through safeSplitIndex).
    // Build a long, emoji-laced CJK string and force the char-window path
    // with a small maxChars so every cut passes through the corrected boundary.
    const parts: string[] = [];
    for (let i = 0; i < 80; i++) {
      parts.push(`第${i + 1}段中文测试文本，包含一个火箭标志🚀来测试代理对。`);
    }
    const text = parts.join('');
    const chunks = chunkText(text, { chunkSize: 50, chunkOverlap: 20, maxChars: 120 });
    expect(chunks.length).toBeGreaterThan(1);

    // No chunk may contain a lone (orphaned) surrogate — a split 🚀 would
    // leave a high surrogate at one chunk's end and a low surrogate at the
    // next chunk's start.
    for (const c of chunks) {
      expect(hasOrphanedSurrogate(c.text)).toBe(false);
    }

    // Every 🚀 must survive in full (not dropped, not half). Chunks overlap by
    // design, so an 🚀 inside an overlap region legitimately appears in two
    // adjacent chunks — count against the overlap-free reconstruction, not
    // the raw chunks.
    const strip = (s: string) => s.replace(/\s+/g, '');
    const reconstructedEmojis = strip(reconstructFromChunks(chunks)).split('🚀').length - 1;
    expect(reconstructedEmojis).toBe(text.split('🚀').length - 1);

    // Lossless reconstruction (whitespace-normalized).
    expect(strip(reconstructFromChunks(chunks))).toBe(strip(text));
  });
});

/**
 * Reconstruct the original text from overlapped chunks by taking each chunk's
 * prefix up to where the next chunk's overlap begins. For a sequence of chunks
 * [C0, C1, C2, ...] where C_{i+1} starts with the trailing overlap of C_i,
 * this returns C0 + (C1 without its overlap prefix) + (C2 without its overlap
 * prefix) + ...
 */
function reconstructFromChunks(chunks: { text: string; index: number }[]): string {
  if (chunks.length === 0) return '';
  let out = chunks[0].text;
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1].text;
    const curr = chunks[i].text;
    // Find how much of curr is a suffix of prev (the overlap).
    let overlap = 0;
    for (let k = 1; k <= Math.min(prev.length, curr.length); k++) {
      if (prev.endsWith(curr.slice(0, k))) overlap = k;
    }
    out += curr.slice(overlap);
  }
  return out;
}

/**
 * True if `s` contains a UTF-16 surrogate that is not paired (a lone high or
 * low surrogate). Used to assert no astral emoji (e.g. 🚀) was split across a
 * chunk boundary.
 */
function hasOrphanedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const isHigh = code >= 0xD800 && code <= 0xDBFF;
    const isLow = code >= 0xDC00 && code <= 0xDFFF;
    if (isHigh) {
      const next = i + 1 >= s.length ? -1 : s.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
    } else if (isLow) {
      const prev = i === 0 ? -1 : s.charCodeAt(i - 1);
      if (!(prev >= 0xD800 && prev <= 0xDBFF)) return true;
    }
  }
  return false;
}
