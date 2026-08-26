/**
 * SUP-3874 — heal already-stored chunks that exceed the embedding input cap.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  healOversizedChunks,
  isEmbeddingOversizeError,
} from '../src/core/embed-oversize-heal.ts';
import { estimateEmbedTokens } from '../src/core/chunkers/token-estimate.ts';
import { EMBED_INPUT_SAFETY } from '../src/core/embedding-input-limit.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

beforeEach(() => {
  resetGateway();
});

afterAll(() => {
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

const MXBAI_CAP = Math.floor(512 * EMBED_INPUT_SAFETY); // 307

function fatParagraph(n: number): string {
  const para =
    'The SuperAICoach SEO implementation plan covers technical setup, content calendars, schema markup, and local Philadelphia keyword clusters that must remain searchable after re-embedding. ';
  return Array.from({ length: n }, () => para).join('\n\n');
}

describe('isEmbeddingOversizeError', () => {
  test('matches ollama mxbai context-length failures', () => {
    expect(
      isEmbeddingOversizeError(
        new Error('[embed(ollama:mxbai-embed-large)] the input length exceeds the context length'),
      ),
    ).toBe(true);
  });

  test('matches OpenAI / Voyage oversize shapes', () => {
    expect(isEmbeddingOversizeError("This model's maximum context length is 8192 tokens")).toBe(true);
    expect(isEmbeddingOversizeError('input length exceeds maximum')).toBe(true);
    expect(isEmbeddingOversizeError('max_tokens exceeded for embedding input')).toBe(true);
  });

  test('ignores unrelated errors', () => {
    expect(isEmbeddingOversizeError(new Error('rate limit exceeded'))).toBe(false);
    expect(isEmbeddingOversizeError(new Error('connection refused'))).toBe(false);
  });
});

describe('healOversizedChunks', () => {
  test('no-op when every chunk already fits', () => {
    const chunks = [
      { chunk_index: 0, chunk_text: 'short one', chunk_source: 'compiled_truth' as const, token_count: 2 },
      { chunk_index: 1, chunk_text: 'short two', chunk_source: 'compiled_truth' as const, token_count: 2 },
    ];
    const result = healOversizedChunks(chunks, MXBAI_CAP);
    expect(result.changed).toBe(false);
    expect(result.splitCount).toBe(0);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks.map((c) => c.chunk_text)).toEqual(['short one', 'short two']);
  });

  test('splits only the oversized row and keeps siblings', () => {
    const oversized = fatParagraph(40);
    expect(estimateEmbedTokens(oversized)).toBeGreaterThan(MXBAI_CAP);

    const chunks = [
      { chunk_index: 0, chunk_text: 'lead-in', chunk_source: 'compiled_truth' as const, token_count: 2 },
      { chunk_index: 1, chunk_text: oversized, chunk_source: 'compiled_truth' as const, token_count: 5000 },
      { chunk_index: 2, chunk_text: 'closing', chunk_source: 'timeline' as const, token_count: 2 },
    ];
    const result = healOversizedChunks(chunks, MXBAI_CAP);
    expect(result.changed).toBe(true);
    expect(result.splitCount).toBe(1);
    expect(result.chunks.length).toBeGreaterThan(3);
    expect(result.chunks[0].chunk_text).toBe('lead-in');
    expect(result.chunks[result.chunks.length - 1].chunk_text).toBe('closing');
    expect(result.chunks[result.chunks.length - 1].chunk_source).toBe('timeline');
    for (const c of result.chunks) {
      expect(estimateEmbedTokens(c.chunk_text)).toBeLessThanOrEqual(MXBAI_CAP);
      expect(c.chunk_index).toBe(result.chunks.indexOf(c));
    }
    // Split, not truncated: joined body of middle pieces still covers the original.
    const middle = result.chunks.slice(1, -1).map((c) => c.chunk_text).join('');
    expect(middle.length).toBeGreaterThanOrEqual(Math.floor(oversized.length * 0.9));
  });

  test('reindexes contiguously after a split', () => {
    const oversized = fatParagraph(40);
    const result = healOversizedChunks(
      [{ chunk_index: 7, chunk_text: oversized, chunk_source: 'compiled_truth' as const, token_count: null }],
      MXBAI_CAP,
    );
    expect(result.changed).toBe(true);
    expect(result.chunks.map((c) => c.chunk_index)).toEqual(
      result.chunks.map((_, i) => i),
    );
  });

  test('preserves modality and code metadata on every split piece', () => {
    const oversized = fatParagraph(40);
    const result = healOversizedChunks([{
      chunk_index: 0,
      chunk_text: oversized,
      chunk_source: 'fenced_code' as const,
      token_count: 5000,
      modality: 'image' as const,
      language: 'typescript',
      symbol_name: 'buildIndex',
      symbol_type: 'function',
      start_line: 10,
      end_line: 90,
      parent_symbol_path: ['SearchEngine'],
      doc_comment: 'Build the searchable index.',
      symbol_name_qualified: 'SearchEngine.buildIndex',
    }], MXBAI_CAP);

    expect(result.changed).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.modality).toBe('image');
      expect(chunk.language).toBe('typescript');
      expect(chunk.symbol_name).toBe('buildIndex');
      expect(chunk.symbol_type).toBe('function');
      expect(chunk.start_line).toBe(10);
      expect(chunk.end_line).toBe(90);
      expect(chunk.parent_symbol_path).toEqual(['SearchEngine']);
      expect(chunk.doc_comment).toBe('Build the searchable index.');
      expect(chunk.symbol_name_qualified).toBe('SearchEngine.buildIndex');
    }
  });
});
