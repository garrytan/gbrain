import { describe, expect, test } from 'bun:test';
import { canReuseMarkdownVector } from '../src/core/embed-reuse.ts';
import { embeddingInputHash, type EmbeddingInputContext } from '../src/core/embedding-input-hash.ts';
import { digest, sha256 } from '../src/core/persistence/digest.ts';

const chunk = { chunk_text: 'A short body.' };
const provenance: EmbeddingInputContext = {
  column: 'embedding',
  model: 'ollama:embeddinggemma:latest',
  dimensions: 768,
  title: 'A real title',
  corpusGeneration: null,
  bodyHash: 'body-1',
};

function v1Hash(ctx: EmbeddingInputContext): string {
  return digest(['embedding-input-v1', ctx.column, ctx.model, ctx.dimensions, 'none', null, sha256(chunk.chunk_text)]);
}

describe('canReuseMarkdownVector for formatted document inputs', () => {
  test('rejects a legacy vector without an input hash when the model formats documents', () => {
    expect(canReuseMarkdownVector(null, null, 'none', provenance, { ...chunk, model: provenance.model })).toBe(false);
  });

  test('rejects a legacy v1 hash when the current formatted input hash is v2', () => {
    expect(canReuseMarkdownVector(v1Hash(provenance), null, 'none', provenance, chunk)).toBe(false);
  });

  test('reuses a valid v2 hash while the title and input stay unchanged', () => {
    const hash = embeddingInputHash(provenance, 'none', chunk);
    expect(canReuseMarkdownVector(hash, null, 'none', provenance, chunk)).toBe(true);
    expect(canReuseMarkdownVector(hash, null, 'none', { ...provenance, title: 'A different title' }, chunk)).toBe(false);
  });

  test('preserves same-model null-hash reuse for models without formatted document inputs', () => {
    const unaffected = { ...provenance, model: 'ollama:nomic-embed-text' };
    expect(canReuseMarkdownVector(null, null, 'none', unaffected, { ...chunk, model: unaffected.model })).toBe(true);
  });
});
