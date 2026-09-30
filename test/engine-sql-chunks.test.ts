/**
 * engine-sql/chunks.ts keeps one fragment copy of the shared
 * `currentSpaceChunkPredicate` (embedding-invalidation.ts), because engine-sql
 * composes with sqlFragment and bans hand-numbered `$n`
 * (docs/designs/refactor-wave-1/w1-inventory.md, chunks). This pins the two
 * texts together so an edit to one cannot silently leave the other behind:
 * the fragment rendered at its placeholder positions must equal the shared
 * builder's text, and bind exactly (model, dims). It also pins
 * `decodeEmbedding` (getEmbeddingsByChunkIds' vector decoder) to
 * `tryParseEmbedding` for well-formed, malformed and non-string inputs.
 */
import { describe, expect, test } from 'bun:test';
import { currentSpaceChunkPredicate } from '../src/core/embedding-invalidation.ts';
import { quoteIdentifier } from '../src/core/search/embedding-column.ts';
import { currentSpaceChunkFragment, decodeEmbedding } from '../src/core/engine-sql/chunks.ts';
import { tryParseEmbedding } from '../src/core/utils.ts';
import { renderFragment } from '../src/core/engine-sql/fragment.ts';

describe('engine-sql chunks: currentSpaceChunkFragment', () => {
  for (const column of ['embedding', 'embedding_voyage']) {
    test(`renders currentSpaceChunkPredicate's exact text for ${column}`, () => {
      const { text, params } = renderFragment(currentSpaceChunkFragment(column, 'voyage:voyage-4', 1024));
      expect(text).toBe(currentSpaceChunkPredicate(quoteIdentifier(column), 1, 2));
      expect(params).toEqual(['voyage:voyage-4', 1024]);
    });
  }
});

describe('engine-sql chunks: decodeEmbedding', () => {
  const inputs: unknown[] = [
    '[0.1,-0.25,3e-8,1024]', ' [ 1 , 2.5 ] ', '[]', '[1,,2]', '[1.,+2,0x10]', '[1e999]', '[NaN]',
    '[1,[2]]', '"[1,2]"', '5', 'not-a-vector', '[1,2', '', null, undefined,
    [0.5, 1.5], new Float32Array([0.25, 0.75]),
  ];
  for (const input of inputs) {
    test(`matches tryParseEmbedding for ${JSON.stringify(input) ?? String(input)}`, () => {
      const expected = tryParseEmbedding(input);
      const actual = decodeEmbedding(input);
      expect(actual === null ? null : Array.from(actual)).toEqual(expected === null ? null : Array.from(expected));
    });
  }

  test('decodes a 1024-d pgvector literal exactly like tryParseEmbedding', () => {
    const literal = '[' + Array.from({ length: 1024 }, (_, i) => ((i * 7919) % 2001 / 1000 - 1).toFixed(8)).join(',') + ']';
    expect(Array.from(decodeEmbedding(literal)!)).toEqual(Array.from(tryParseEmbedding(literal)!));
  });
});
