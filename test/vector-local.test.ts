import { expect, test } from 'bun:test';
import { searchLocalVectors } from '../src/core/search/vector-local.ts';

test('local vector search preserves stable chunk identity fields', () => {
  const [result] = searchLocalVectors(
    new Float32Array([1, 0]),
    [{
      slug: 'systems/mbrain',
      page_id: 42,
      title: 'MBrain',
      type: 'system',
      chunk_text: 'stable identity chunk',
      chunk_source: 'compiled_truth',
      chunk_index: 7,
      chunk_content_hash: 'hash:stable-identity',
      stale: false,
      embedding: new Float32Array([1, 0]),
    }],
    1,
  );

  expect(result).toMatchObject({
    slug: 'systems/mbrain',
    chunk_index: 7,
    chunk_content_hash: 'hash:stable-identity',
  });
});
