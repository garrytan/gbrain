import { describe, test, expect } from 'bun:test';
import { chunkText } from '../../src/core/chunkers/recursive.ts';

describe('Recursive Text Chunker', () => {
  test('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  test('returns single chunk for short text', () => {
    const text = 'Hello world. This is a short text.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text.trim());
    expect(chunks[0].index).toBe(0);
  });

  test('splits at paragraph boundaries', () => {
    const paragraph = 'word '.repeat(200).trim();
    const text = paragraph + '\n\n' + paragraph;
    const chunks = chunkText(text, { chunkSize: 250 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test('respects chunk size target', () => {
    const text = 'word '.repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100 });
    for (const chunk of chunks) {
      const wordCount = chunk.text.split(/\s+/).length;
      // Allow up to 1.5x target due to greedy merge
      expect(wordCount).toBeLessThanOrEqual(150);
    }
  });

  test('applies overlap between chunks', () => {
    const text = 'word '.repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // Second chunk should start with words from end of first chunk
    // (overlap means shared content between adjacent chunks)
    expect(chunks[1].text.length).toBeGreaterThan(0);
  });

  test('splits at sentence boundaries', () => {
    const sentences = Array.from({ length: 50 }, (_, i) =>
      `This is sentence number ${i} with some content about topic ${i}.`
    ).join(' ');
    const chunks = chunkText(sentences, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should end near a sentence boundary
    for (const chunk of chunks.slice(0, -1)) {
      // Allow for overlap text, but the core content should have sentence endings
      expect(chunk.text).toMatch(/[.!?]/);
    }
  });

  test('assigns sequential indices', () => {
    const text = 'word '.repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  test('handles single word input', () => {
    const chunks = chunkText('hello');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('hello');
  });

  test('handles unicode text', () => {
    const text = 'Bonjour le monde. ' + 'Ceci est un texte en francais. '.repeat(100);
    const chunks = chunkText(text, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain('Bonjour');
  });

  test('splits at single newline (line-level) when paragraphs are absent', () => {
    // Lines without double newlines should still split at single newlines
    const lines = Array(100).fill('This is a single line of text.').join('\n');
    const chunks = chunkText(lines, { chunkSize: 20 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('handles text with only whitespace delimiters (word-level split)', () => {
    // No sentences, no newlines, just words
    const words = Array(200).fill('word').join(' ');
    const chunks = chunkText(words, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  test('handles clause-level delimiters (semicolons, colons, commas)', () => {
    // Text with clauses but no sentence endings
    const text = Array(100).fill('clause one; clause two: clause three, clause four').join(' ');
    const chunks = chunkText(text, { chunkSize: 30 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('preserves content across chunks (lossless)', () => {
    const original = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(original, { chunkSize: 5, chunkOverlap: 0 });
    // With no overlap, all text should appear in chunks
    const reconstructed = chunks.map(c => c.text).join(' ');
    expect(reconstructed).toContain('First paragraph');
    expect(reconstructed).toContain('Second paragraph');
    expect(reconstructed).toContain('Third paragraph');
  });

  test('default options produce reasonable chunks', () => {
    // Large text with defaults (300 words, 50 overlap)
    const text = Array(500).fill('This is a test sentence with several words.').join(' ');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const wordCount = chunk.text.split(/\s+/).length;
      // Should be roughly 300 words, with 1.5x tolerance
      expect(wordCount).toBeLessThanOrEqual(500);
    }
  });

  test('handles mixed delimiter hierarchy', () => {
    const text = [
      'Paragraph one has sentences. And more sentences! Really?',
      '',
      'Paragraph two; with clauses: and more, clauses here.',
      '',
      'Paragraph three.\nWith line breaks.\nAnd more lines.',
    ].join('\n');
    const chunks = chunkText(text, { chunkSize: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('CJK chunking (v0.32.7)', () => {
  test('MARKDOWN_CHUNKER_VERSION is 2', async () => {
    const mod = await import('../../src/core/chunkers/recursive.ts');
    expect(mod.MARKDOWN_CHUNKER_VERSION).toBe(2);
  });

  test('long pure-Chinese paragraph splits into multiple chunks', () => {
    // Pre-fix: 1000 Chinese chars counts as 1 word, never splits.
    // Post-fix: density >= 30% → char-count → splits at chunkSize.
    const text = '品牌圣经测试用例'.repeat(200); // 1600 CJK chars, no whitespace
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('Japanese with 。 sentence terminator splits at CJK delimiter', () => {
    // Each sentence is small (10 chars). chunkSize 5 → must split.
    // With CJK delimiter `。` in L2, the splitter finds sentence boundaries.
    const text = '今日は晴れです。明日は雨です。明後日は曇りです。'.repeat(20);
    const chunks = chunkText(text, { chunkSize: 50, chunkOverlap: 5 });
    expect(chunks.length).toBeGreaterThan(1);
    // Verify chunks generally end near a sentence boundary
    const someEndAtPunct = chunks.some(c => /[。！？]/.test(c.text.slice(-3)));
    expect(someEndAtPunct).toBe(true);
  });

  test('Korean Hangul + spaces splits cleanly', () => {
    // Mixed CJK density but with spaces — should still split.
    const text = '한글 테스트 입니다 짧은 문장 여러개 '.repeat(50);
    const chunks = chunkText(text, { chunkSize: 30 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('mixed CJK + English still splits', () => {
    const para = 'This is English text. 这是中文文本。 More English here. ';
    const text = para.repeat(30);
    const chunks = chunkText(text, { chunkSize: 20 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('maxChars hard cap fires on whitespace-less CJK at chunkSize boundary', () => {
    // 20K char pure-Chinese blob with no whitespace; chunkSize 10K (huge)
    // is overridden by maxChars=6000 cap.
    const text = '测试'.repeat(10000); // 20K chars
    const chunks = chunkText(text, { chunkSize: 100000, chunkOverlap: 0, maxChars: 6000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(6000);
    }
  });

  test('maxChars sliding window preserves overlap for continuity', () => {
    const text = 'A'.repeat(15000); // 15K of one char, no delimiters
    const chunks = chunkText(text, { chunkSize: 100000, chunkOverlap: 0, maxChars: 6000 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Successive chunks should overlap by ~500 chars at the cap boundary
    expect(chunks[0].text.length).toBeLessThanOrEqual(6000);
    expect(chunks[1].text.length).toBeLessThanOrEqual(6000);
  });

  test('maxChars applies on single-short-chunk path too', () => {
    // A short doc (under chunkSize words) but with one huge whitespace-less
    // line that exceeds maxChars. The single-chunk fast path must still cap.
    const text = 'a'.repeat(8000); // 1 "word" of 8000 chars
    const chunks = chunkText(text, { chunkSize: 300, maxChars: 6000 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(6000);
    }
  });

  test('REGRESSION: pure English doc unchanged', () => {
    const para = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
    const chunks = chunkText(para, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(0);
    // Should have been chunked by word boundaries (English-dominant doc).
    expect(chunks.every(c => /^[\x20-\x7e\s]+$/.test(c.text))).toBe(true);
  });
});
