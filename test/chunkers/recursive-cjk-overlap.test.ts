import { describe, test, expect } from 'bun:test';
import { chunkText } from '../../src/core/chunkers/recursive.ts';

describe('CJK chunk overlap & boundary fixes', () => {
  test('Chinese sentences align overlap to CJK sentence boundaries', () => {
    // 40 short Chinese sentences, each 9-10 chars. Whitespace tokenization
    // treated each sentence as one "word"; overlap either vanished or
    // spanned whole sentences. The CJK path counts chars and splits on 。！？
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
      const actualOverlap = overlapLength(prev, chunks[i].text);
      expect(actualOverlap).toBeGreaterThan(0);
      // Overlap should not swallow the whole previous chunk.
      expect(actualOverlap).toBeLessThan(prev.length);
      // Overlap should be bounded by a small multiple of target overlap chars.
      expect(actualOverlap).toBeLessThanOrEqual(Math.max(overlapChars, 30) * 3);
    }

    const strip = (s: string) => s.replace(/\s+/g, '');
    expect(strip(reconstructFromChunks(chunks))).toBe(strip(text));
  });

  test('ASCII period inside CJK prose is not a sentence boundary for the overlap', () => {
    // Overlap window of 16 starts exactly at the "3" of "3.5" (or the ".")
    // for every sentence. Treating that "." as a sentence end would start the
    // next chunk at "5相关…"; only a whitespace-followed ASCII terminator
    // (or a CJK 。！？) may align the overlap.
    const text = Array.from(
      { length: 30 },
      (_, i) => `版本3.5相关内容第${i + 1}条，还有更多。`,
    ).join('');
    const chunks = chunkText(text, { chunkSize: 40, chunkOverlap: 16 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(overlapLength(chunks[i - 1].text, chunks[i].text)).toBeGreaterThan(0);
      expect(chunks[i].text.startsWith('5相关')).toBe(false);
    }
  });

  test('a CJK chunk shorter than the overlap target is not duplicated wholesale', () => {
    // Every sentence is < 30 chars; the English path returns '' for a chunk
    // with fewer words than the overlap target, and the CJK path must too.
    const text = '第一句话很短。第二句话也不长。第三句话稍微长一点点。第四句话结束了。';
    const chunks = chunkText(text, { chunkSize: 8, chunkOverlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].text.includes(chunks[i - 1].text)).toBe(false);
    }
  });

  test('char-slice fallback keeps astral pairs whole and stays lossless', () => {
    // Delimiter-free, whitespace-free CJK with an emoji every 44 code units
    // reaches the L4 char-slice path (one whitespace token longer than the
    // target). A raw slice at a 13-unit stride halves a 🚀 at some boundary;
    // the safeSplitIndex cursor must cut around the pair without dropping or
    // repeating a single code unit. (chunkOverlap 0 is treated as the
    // default 50, so use 1.)
    const text = ('一二三四五六七八九十'.repeat(4) + '🚀' + '甲乙丙丁').repeat(12);
    const chunks = chunkText(text, { chunkSize: 13, chunkOverlap: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.isWellFormed()).toBe(true);
    }

    // Tile the source with the chunks: each one must be found at the cursor,
    // backed up by at most its overlap (1 char, or a whole pair plus 1).
    let cursor = 0;
    for (const c of chunks) {
      let start = -1;
      for (let k = 0; k <= 4; k++) {
        if (cursor - k >= 0 && text.startsWith(c.text, cursor - k)) {
          start = cursor - k;
          break;
        }
      }
      expect(start).toBeGreaterThanOrEqual(0);
      cursor = start + c.text.length;
    }
    expect(cursor).toBe(text.length);
  });

  test('emoji survive overlap path at production chunk params', () => {
    // Production ingest calls chunkText with ONLY { maxTokens } — chunkSize
    // 300 / overlap 50 / maxChars 6000 defaults apply, and the overlap is
    // prepended via extractTrailingContext, not the capByChars path.
    const parts: string[] = [];
    for (let i = 0; i < 120; i++) {
      parts.push(`第${i + 1}段中文说明文字，这里有一枚火箭🚀用于测试代理对完整性。`);
    }
    const text = parts.join('\n');
    const chunks = chunkText(text, { maxTokens: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      expect(c.text.isWellFormed()).toBe(true);
    }

    // Lossless reconstruction (whitespace-normalized) — no glyph dropped,
    // no glyph duplicated outside designed overlap.
    const strip = (s: string) => s.replace(/\s+/g, '');
    expect(strip(reconstructFromChunks(chunks))).toBe(strip(text));
  });

  test('English chunks are byte-identical to the pre-CJK-overlap output', () => {
    // Pure ASCII stays on the whitespace-token path. Hard-coded snapshot of
    // the chunker's output before the CJK overlap branch existed; any drift
    // here means the English path changed.
    const sentences = Array.from(
      { length: 20 },
      (_, i) => `Sentence ${i + 1} has exactly eight words in it here.`,
    );
    const chunks = chunkText(sentences.join(' '), { chunkSize: 40, chunkOverlap: 8 });
    expect(chunks.map((c) => c.text)).toEqual([
      'Sentence 1 has exactly eight words in it here. Sentence 2 has exactly eight words in it here. Sentence 3 has exactly eight words in it here. Sentence 4 has exactly eight words in it here. Sentence 5 has exactly eight words in it here. Sentence 6 has exactly eight words in it here.',
      '6 has exactly eight words in it here. Sentence 7 has exactly eight words in it here. Sentence 8 has exactly eight words in it here. Sentence 9 has exactly eight words in it here. Sentence 10 has exactly eight words in it here. Sentence 11 has exactly eight words in it here. Sentence 12 has exactly eight words in it here.',
      '12 has exactly eight words in it here. Sentence 13 has exactly eight words in it here. Sentence 14 has exactly eight words in it here. Sentence 15 has exactly eight words in it here. Sentence 16 has exactly eight words in it here. Sentence 17 has exactly eight words in it here. Sentence 18 has exactly eight words in it here.',
      '18 has exactly eight words in it here. Sentence 19 has exactly eight words in it here. Sentence 20 has exactly eight words in it here.',
    ]);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  test('emoji surrogate pairs survive CJK chunk boundaries whole', () => {
    // Emoji such as 🚀 are astral: each is a UTF-16 surrogate PAIR (2 code
    // units). Force the maxChars window path with a small cap so every cut
    // passes through a boundary, and require every pair to stay whole.
    const parts: string[] = [];
    for (let i = 0; i < 80; i++) {
      parts.push(`第${i + 1}段中文测试文本，包含一个火箭标志🚀来测试代理对。`);
    }
    const text = parts.join('');
    const chunks = chunkText(text, { chunkSize: 50, chunkOverlap: 20, maxChars: 120 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      expect(c.text.isWellFormed()).toBe(true);
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

/** Longest prefix of `curr` that is a suffix of `prev` (the designed overlap). */
function overlapLength(prev: string, curr: string): number {
  let overlap = 0;
  for (let k = 1; k <= Math.min(prev.length, curr.length); k++) {
    if (prev.endsWith(curr.slice(0, k))) overlap = k;
  }
  return overlap;
}

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
    out += chunks[i].text.slice(overlapLength(chunks[i - 1].text, chunks[i].text));
  }
  return out;
}
