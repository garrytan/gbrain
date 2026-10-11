import { describe, expect, test } from 'bun:test';
import { formatEmbeddingInput } from '../src/core/ai/model-resolver.ts';
import { prepareEmbedInputs } from '../src/core/ai/embed-batch-plan.ts';
import { digest, sha256 } from '../src/core/persistence/digest.ts';
import {
  acceptedEmbeddingInputHashes,
  embeddingInputHash,
  type EmbeddingInputContext,
  type EmbeddingTier,
} from '../src/core/embedding-input-hash.ts';

// Protects stored provenance for formatter-prepared request bytes and legacy synopsis receipts.
// It fails if formatted document metadata stops invalidating vectors or changes an unaffected hash.
// Existing formatter tests pin request text, but not the provenance that projection reuse trusts.
// No production-only seam is needed; this calls the existing recipe formatter and request preparer.

const model = 'ollama:embeddinggemma:latest';
const base: EmbeddingInputContext = {
  column: 'embedding',
  model,
  dimensions: 768,
  title: 'A real title',
  corpusGeneration: 'corpus-1',
  bodyHash: 'body-1',
};
type TestChunk = { chunk_text: string; chunk_source?: string };
const chunk: TestChunk = { chunk_text: 'A short body.' };

function oldHash(ctx: EmbeddingInputContext, tier: EmbeddingTier, source: TestChunk = chunk): string {
  const raw = tier === 'none' || source.chunk_source === 'fenced_code';
  const input = raw ? source.chunk_text : tier === 'title'
    ? `<context>${ctx.title}\n</context>\n${source.chunk_text}`
    : digest([ctx.title, ctx.bodyHash, source.chunk_text]);
  return digest(['embedding-input-v1', ctx.column, ctx.model, ctx.dimensions, tier,
    tier === 'per_chunk_synopsis' ? ctx.corpusGeneration : null, sha256(input)]);
}

function expectedFormattedHash(ctx: EmbeddingInputContext, tier: EmbeddingTier, source: TestChunk = chunk): string {
  const tierInput = tier === 'none' || (tier === 'title' && source.chunk_source === 'fenced_code')
    ? source.chunk_text : tier === 'title' ? `<context>${ctx.title}\n</context>\n${source.chunk_text}` : source.chunk_text;
  const prepared = prepareEmbedInputs([tierInput], ctx.model!, {
    inputType: 'document', documentTitle: ctx.title,
  })[0]!;
  return digest(['embedding-input-v2', ctx.column, ctx.model, ctx.dimensions, tier, null, sha256(prepared)]);
}

describe('embedding document provenance', () => {
  test('requires proof only when explicit title metadata changes a non-empty recipe input', async () => {
    const hashModule = await import('../src/core/embedding-input-hash.ts');
    const requiresProof = (hashModule as Record<string, unknown>).requiresEmbeddingInputProof;
    expect(typeof requiresProof).toBe('function');
    const check = requiresProof as (model: string | null) => boolean;
    expect(check(model)).toBe(true);
    for (const unaffected of [null, 'ollama:nomic-embed-text', 'unknown:embeddinggemma:latest']) {
      expect(check(unaffected)).toBe(false);
    }
    expect(formatEmbeddingInput('probe', model, {
      inputType: 'document', documentTitle: 'explicit title',
    })).not.toBe('probe');
  });

  test('hashes the titled and truncated prepared request for none, title, and fenced code tiers', () => {
    for (const tier of ['none', 'title'] as const) {
      expect(embeddingInputHash(base, tier, chunk)).toBe(expectedFormattedHash(base, tier, chunk));
    }
    const fenced = { chunk_text: '```ts\nconst café = 1;\n```', chunk_source: 'fenced_code' };
    expect(embeddingInputHash(base, 'title', fenced)).toBe(expectedFormattedHash(base, 'title', fenced));

    const long = '🙂'.repeat(5000);
    const truncatedCtx = { ...base, title: 'A title that survives UTF-8 truncation' };
    const actual = prepareEmbedInputs([long], model, {
      inputType: 'document', documentTitle: truncatedCtx.title,
    })[0]!;
    expect(actual.length).toBeLessThanOrEqual(8000);
    expect(actual.endsWith('🙂')).toBe(true);
    expect(Buffer.byteLength(actual, 'utf8')).toBeLessThan(Buffer.byteLength(`title: ${truncatedCtx.title} | text: ${long}`, 'utf8'));
    expect(embeddingInputHash(truncatedCtx, 'none', { chunk_text: long })).toBe(
      digest(['embedding-input-v2', truncatedCtx.column, model, truncatedCtx.dimensions,
        'none', null, sha256(actual)]),
    );

    const untitled = { ...base, title: '' };
    expect(embeddingInputHash(untitled, 'none', chunk)).toBe(expectedFormattedHash(untitled, 'none', chunk));
    expect(embeddingInputHash(untitled, 'none', chunk)).not.toBe(embeddingInputHash(base, 'none', chunk));
    const tagged = { ...base, model: 'ollama:embeddinggemma:300m' };
    expect(embeddingInputHash(tagged, 'none', chunk)).toBe(expectedFormattedHash(tagged, 'none', chunk));
  });

  test('title edits invalidate formatted vectors and cannot match their literal v1 hashes', () => {
    for (const [tier, source] of [
      ['none', chunk],
      ['title', chunk],
      ['none', { ...chunk, chunk_source: 'fenced_code' }],
    ] as const) {
      const renamed = { ...base, title: 'A different title' };
      const current = embeddingInputHash(base, tier, source);
      expect(embeddingInputHash(renamed, tier, source)).not.toBe(current);
      expect(current).not.toBe(oldHash(base, tier, source));
    }
  });

  test('preserves historical hashes byte-for-byte for null, unknown, and unaffected models', () => {
    for (const candidate of [null, 'unknown:embeddinggemma:latest', 'ollama:nomic-embed-text']) {
      const ctx = { ...base, model: candidate };
      for (const tier of ['none', 'title', 'per_chunk_synopsis'] as const) {
        expect(embeddingInputHash(ctx, tier, chunk)).toBe(oldHash(ctx, tier));
      }
    }
  });

  test('keeps synopsis semantic receipts and adds formatted document identity', () => {
    const formattedProbe = prepareEmbedInputs(['gbrain document format probe'], model, {
      inputType: 'document', documentTitle: base.title,
    })[0]!;
    const semanticReceipt = digest([base.title, base.bodyHash, chunk.chunk_text]);
    const expected = digest(['embedding-input-v2', base.column, model, base.dimensions,
      'per_chunk_synopsis', base.corpusGeneration, sha256(semanticReceipt), sha256(formattedProbe)]);
    const current = embeddingInputHash(base, 'per_chunk_synopsis', chunk);
    expect(current).toBe(expected);
    expect(current).not.toBe(oldHash(base, 'per_chunk_synopsis'));
    expect(embeddingInputHash({ ...base, corpusGeneration: 'corpus-2' }, 'per_chunk_synopsis', chunk)).not.toBe(current);
    expect(embeddingInputHash({ ...base, bodyHash: 'body-2' }, 'per_chunk_synopsis', chunk)).not.toBe(current);
    expect(embeddingInputHash({ ...base, title: 'A different title' }, 'per_chunk_synopsis', chunk)).not.toBe(current);
    expect(acceptedEmbeddingInputHashes(base, 'per_chunk_synopsis', chunk)).toContain(
      embeddingInputHash(base, 'title', chunk),
    );
  });

  test('hashes truncated, titled fenced code as prepared bytes in the synopsis tier', () => {
    const fencedText = `\`\`\`ts\n${'x'.repeat(9000)}\n\`\`\``;
    const formatPrefix = `title: ${base.title} | text: `;
    const expectedInput = formatPrefix + fencedText.slice(0, 8000 - formatPrefix.length);
    expect(expectedInput.length).toBe(8000);
    const expectedHash = digest(['embedding-input-v2', base.column, model, base.dimensions,
      'per_chunk_synopsis', base.corpusGeneration, sha256(expectedInput)]);
    const code = { chunk_text: fencedText, chunk_source: 'fenced_code' };

    expect(embeddingInputHash(base, 'per_chunk_synopsis', code)).toBe(expectedHash);

    const renamed = { ...base, title: 'A new title' };
    const renamedPrefix = `title: ${renamed.title} | text: `;
    const renamedInput = renamedPrefix + fencedText.slice(0, 8000 - renamedPrefix.length);
    const renamedHash = digest(['embedding-input-v2', renamed.column, model, renamed.dimensions,
      'per_chunk_synopsis', renamed.corpusGeneration, sha256(renamedInput)]);
    expect(embeddingInputHash(renamed, 'per_chunk_synopsis', code)).toBe(renamedHash);
    expect(renamedHash).not.toBe(expectedHash);
  });
});
