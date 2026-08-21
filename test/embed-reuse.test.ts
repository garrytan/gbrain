/**
 * planEmbeddingReuse — code-chunk embedding reuse keyed on the header-stripped
 * body. Regression surface: the old `${chunk_index}:${chunk_text}` key missed
 * whenever line numbers or the index shifted, re-embedding identical bodies.
 */

import { describe, test, expect } from 'bun:test';
import { planEmbeddingReuse, type ReusableChunk } from '../src/core/embed-reuse.ts';
import { stripChunkHeader } from '../src/core/chunkers/code.ts';

const BODY_A = 'export function a() {\n  return 1;\n}';
const BODY_B = 'export function b() {\n  return 2;\n}';

function stored(header: string, body: string, embedding: Float32Array | null = new Float32Array([1, 2])): ReusableChunk {
  return { chunk_text: `${header}\n\n${body}`, embedding, token_count: 7 };
}

describe('planEmbeddingReuse', () => {
  test('reuses when the header line numbers shifted', () => {
    const existing = [stored('[TypeScript] src/a.ts:62-86 export statement a', BODY_A)];
    const next = [{ chunk_text: `[TypeScript] src/a.ts:64-88 export statement a\n\n${BODY_A}` }];
    const plan = planEmbeddingReuse(existing, next);
    expect(plan.needsEmbedIndexes).toEqual([]);
    expect(plan.reuse.get(0)).toBe(existing[0]!);
    expect(plan.reuse.get(0)!.token_count).toBe(7);
  });

  test('reuses when the chunk index shifted (symbol inserted above)', () => {
    const existing = [stored('[TypeScript] src/a.ts:1-3 export statement a', BODY_A)];
    // The old symbol is now chunk 1, not chunk 0, and its lines moved.
    const next = [
      { chunk_text: `[TypeScript] src/a.ts:1-3 export statement z\n\nexport const z = 0;` },
      { chunk_text: `[TypeScript] src/a.ts:5-7 export statement a\n\n${BODY_A}` },
    ];
    const plan = planEmbeddingReuse(existing, next);
    expect(plan.needsEmbedIndexes).toEqual([0]);
    expect(plan.reuse.get(1)).toBe(existing[0]!);
  });

  test('re-embeds when the body changed', () => {
    const existing = [stored('[TypeScript] src/a.ts:1-3 export statement a', BODY_A)];
    const next = [{ chunk_text: `[TypeScript] src/a.ts:1-3 export statement a\n\n${BODY_B}` }];
    const plan = planEmbeddingReuse(existing, next);
    expect(plan.needsEmbedIndexes).toEqual([0]);
    expect(plan.reuse.size).toBe(0);
  });

  test('two byte-identical bodies get two distinct reuses, no collision', () => {
    const first = stored('[TypeScript] src/a.ts:1-3 method stub', BODY_A, new Float32Array([1]));
    const second = stored('[TypeScript] src/a.ts:9-11 method stub', BODY_A, new Float32Array([2]));
    const next = [
      { chunk_text: `[TypeScript] src/a.ts:2-4 method stub\n\n${BODY_A}` },
      { chunk_text: `[TypeScript] src/a.ts:10-12 method stub\n\n${BODY_A}` },
    ];
    const plan = planEmbeddingReuse([first, second], next);
    expect(plan.needsEmbedIndexes).toEqual([]);
    expect(plan.reuse.size).toBe(2);
    // FIFO: consumed in stored order, and never the same row twice.
    expect(plan.reuse.get(0)).toBe(first);
    expect(plan.reuse.get(1)).toBe(second);
  });

  test('a stored row with no embedding cannot be reused', () => {
    const existing = [stored('[TypeScript] src/a.ts:1-3 export statement a', BODY_A, null)];
    const next = [{ chunk_text: `[TypeScript] src/a.ts:1-3 export statement a\n\n${BODY_A}` }];
    const plan = planEmbeddingReuse(existing, next);
    expect(plan.needsEmbedIndexes).toEqual([0]);
    expect(plan.reuse.size).toBe(0);
  });

});

describe('stripChunkHeader', () => {
  test('leaves text with no header unchanged', () => {
    expect(stripChunkHeader(BODY_A)).toBe(BODY_A);
    expect(stripChunkHeader(`[TypeScript] src/a.ts:1-3 export statement a\n\n${BODY_A}`)).toBe(BODY_A);
  });
});
