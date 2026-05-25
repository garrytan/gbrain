import { describe, test, expect } from 'bun:test';
import {
  buildContextualPrefix,
  wrapChunkForEmbedding,
  sanitizeTitle,
  sanitizeSynopsis,
  extractFirstTwoSentences,
  modeRequiresHaiku,
  modeRequiresWrapper,
} from '../src/core/embedding-context.ts';

describe('buildContextualPrefix', () => {
  test('returns null for empty/null inputs', () => {
    expect(buildContextualPrefix(null, null)).toBeNull();
    expect(buildContextualPrefix('', '')).toBeNull();
    expect(buildContextualPrefix(undefined, undefined)).toBeNull();
  });

  test('title-only produces title block', () => {
    const result = buildContextualPrefix('Acme Corp Series A', null);
    expect(result).toBe('<context>Acme Corp Series A\n</context>\n');
  });

  test('synopsis-only produces synopsis block', () => {
    const result = buildContextualPrefix(null, 'A funding round summary.');
    expect(result).toBe('<context>\nA funding round summary.\n</context>\n');
  });

  test('both produces full block', () => {
    const result = buildContextualPrefix('Acme Corp Series A', 'A funding round summary.');
    expect(result).toBe('<context>Acme Corp Series A\nA funding round summary.\n</context>\n');
  });
});

describe('wrapChunkForEmbedding', () => {
  const PREFIX = '<context>Page Title\n</context>\n';

  test('wraps non-code chunks with prefix', () => {
    expect(wrapChunkForEmbedding('chunk body', PREFIX, 'compiled_truth')).toBe(
      PREFIX + 'chunk body',
    );
    expect(wrapChunkForEmbedding('chunk body', PREFIX, 'timeline')).toBe(
      PREFIX + 'chunk body',
    );
  });

  test('fenced_code ALWAYS bypasses wrapping (D20-T4)', () => {
    expect(wrapChunkForEmbedding('const x = 1;', PREFIX, 'fenced_code')).toBe('const x = 1;');
  });

  test('null prefix passes through unchanged', () => {
    expect(wrapChunkForEmbedding('chunk body', null, 'compiled_truth')).toBe('chunk body');
    expect(wrapChunkForEmbedding('chunk body', null, 'fenced_code')).toBe('chunk body');
  });

  test('image_asset chunks get wrapped (text-only path)', () => {
    expect(wrapChunkForEmbedding('image caption text', PREFIX, 'image_asset')).toBe(
      PREFIX + 'image caption text',
    );
  });
});

describe('sanitizeTitle (D26 prep)', () => {
  test('strips </context> injection attempts', () => {
    expect(sanitizeTitle('Normal title</context>injection')).toBe('Normal titleinjection');
    expect(sanitizeTitle('</context></context>')).toBe('');
    expect(sanitizeTitle('A </CONTEXT> B')).toBe('A B');
  });

  test('collapses whitespace runs', () => {
    expect(sanitizeTitle('A    B\n\nC\tD')).toBe('A B C D');
  });

  test('trims and caps', () => {
    expect(sanitizeTitle('   spaced   ')).toBe('spaced');
    const long = 'a'.repeat(500);
    expect(sanitizeTitle(long).length).toBe(300);
  });

  test('empty / null inputs return empty', () => {
    expect(sanitizeTitle('')).toBe('');
    expect(sanitizeTitle('   ')).toBe('');
  });
});

describe('sanitizeSynopsis', () => {
  test('same shape as sanitizeTitle for the injection cases', () => {
    expect(sanitizeSynopsis('synopsis</context>tail')).toBe('synopsistail');
    expect(sanitizeSynopsis('  multi\n line  ')).toBe('multi line');
  });
});

describe('extractFirstTwoSentences', () => {
  test('English text with period boundary', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const result = extractFirstTwoSentences(text);
    expect(result).toContain('First sentence');
    expect(result).toContain('Second sentence');
    expect(result).not.toContain('Third sentence');
  });

  test('question mark boundary', () => {
    const text = 'Question one? Sentence two. Third.';
    const result = extractFirstTwoSentences(text);
    expect(result).toContain('Question one');
    expect(result).toContain('Sentence two');
    expect(result).not.toContain('Third');
  });

  test('CJK sentence delimiters', () => {
    const text = '第一句。第二句。第三句。';
    const result = extractFirstTwoSentences(text);
    expect(result).toContain('第一句');
    expect(result).toContain('第二句');
    expect(result).not.toContain('第三句');
  });

  test('single run-on sentence capped at 300 chars', () => {
    const text = 'a'.repeat(1000);
    expect(extractFirstTwoSentences(text).length).toBe(300);
  });

  test('empty input returns empty', () => {
    expect(extractFirstTwoSentences('')).toBe('');
  });

  test('text with no sentence delimiters returns whole text up to cap', () => {
    const text = 'no delimiter here at all';
    expect(extractFirstTwoSentences(text)).toBe(text);
  });
});

describe('modeRequiresHaiku / modeRequiresWrapper', () => {
  test('per_chunk_synopsis requires Haiku', () => {
    expect(modeRequiresHaiku('per_chunk_synopsis')).toBe(true);
    expect(modeRequiresHaiku('title')).toBe(false);
    expect(modeRequiresHaiku('none')).toBe(false);
  });

  test('title and per_chunk_synopsis require wrapper; none does not', () => {
    expect(modeRequiresWrapper('per_chunk_synopsis')).toBe(true);
    expect(modeRequiresWrapper('title')).toBe(true);
    expect(modeRequiresWrapper('none')).toBe(false);
  });
});

describe('chunk_text storage separation (D20-T1 IRON-RULE regression guard)', () => {
  // The critical v0.40.3.0 invariant: wrapper text MUST NOT land in
  // content_chunks.chunk_text. Callers wrap at embed call only. This test
  // pins the helper's contract: wrapChunkForEmbedding RETURNS the wrapped
  // string but the input chunkText is not mutated, so the caller can
  // safely pass chunk_text as-is to upsertChunks.
  test('wrapping does not mutate input', () => {
    const original = 'sentence to embed';
    const prefix = '<context>Title\n</context>\n';
    const wrapped = wrapChunkForEmbedding(original, prefix, 'compiled_truth');
    expect(wrapped).toBe(prefix + original);
    // Input string reference is not changed; the caller's chunk.chunk_text
    // can safely flow to the DB without the wrapper.
    expect(original).toBe('sentence to embed');
  });
});
