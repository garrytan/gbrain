/**
 * embedBatch item-count pagination. Quarantined as serial because mock.module
 * replaces the gateway module for this process.
 */

import { describe, expect, mock, test } from 'bun:test';

const gatewayEmbed = mock(async (texts: string[]) =>
  texts.map(() => new Float32Array(1536)),
);

mock.module('../src/core/ai/gateway.ts', () => ({
  embed: gatewayEmbed,
  embedOne: async () => new Float32Array(1536),
  embedQuery: async () => new Float32Array(1536),
  getEmbeddingModel: () => 'dashscope:text-embedding-v2',
  getEmbeddingDimensions: () => 1536,
  embedMultimodal: async () => [],
  embedMultimodalSafe: async () => ({ embeddings: [], failedIndices: [] }),
  embedQueryMultimodal: async () => new Float32Array(1536),
  embedQueryMultimodalImage: async () => new Float32Array(1536),
}));

describe('embedBatch item-count pagination', () => {
  test('splits 26 texts into 25 + 1 before calling the gateway', async () => {
    gatewayEmbed.mockClear();
    const { embedBatch } = await import('../src/core/embedding.ts');
    const progress: Array<[number, number]> = [];

    const texts = Array.from({ length: 26 }, (_, i) => `text-${i}`);
    const result = await embedBatch(texts, {
      onBatchComplete: (done, total) => progress.push([done, total]),
    });

    expect(result).toHaveLength(26);
    expect(gatewayEmbed).toHaveBeenCalledTimes(2);
    expect(gatewayEmbed.mock.calls.map(([textsArg]) => textsArg.length)).toEqual([25, 1]);
    expect(progress).toEqual([[25, 26], [26, 26]]);
  });
});
