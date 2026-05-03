import { describe, test, expect } from 'bun:test';
import { chunkText } from '../src/core/chunkers/recursive.ts';

describe('recursive markdown chunker', () => {
  test('hard-splits long CJK text without whitespace so embedding inputs stay bounded', () => {
    const text = '汉'.repeat(20000);
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map(c => c.text.length))).toBeLessThanOrEqual(6000);
  });
});
