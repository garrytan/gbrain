/**
 * Integration regression for semantic-cache embedding reuse on a cache miss.
 * Serial because the gateway embedding transport is process-global.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearchCached } from '../src/core/search/hybrid.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';

const DIMS = 1536;
let engine: PGLiteEngine;
let embeddedValues: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/cache-embedding-reuse', {
    type: 'note',
    title: 'Cache embedding reuse',
    compiled_truth: 'cache embedding reuse regression fixture',
  });
  await engine.upsertChunks('notes/cache-embedding-reuse', [
    {
      chunk_index: 0,
      chunk_text: 'cache embedding reuse regression fixture',
      chunk_source: 'compiled_truth',
    },
  ]);

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  __setEmbedTransportForTests(async (args: any) => {
    embeddedValues.push(...args.values);
    return {
      embeddings: args.values.map(() =>
        Array.from({ length: DIMS }, (_, index) => index === 0 ? 1 : 0),
      ),
    } as any;
  });
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('hybridSearchCached embedding reuse', () => {
  test('embeds the original once and only embeds expansion variants after a cache miss', async () => {
    embeddedValues = [];
    const original = 'cache embedding reuse unique query';
    const variant = 'cache embedding reuse expanded variant';

    let observedCacheStatus: string | undefined;
    await hybridSearchCached(engine, original, {
      expansion: true,
      expandFn: async () => [original, variant],
      limit: 5,
      onMeta: (meta) => {
        observedCacheStatus = meta.cache?.status;
      },
    });

    expect(observedCacheStatus).toBe('miss');
    expect(embeddedValues.filter(value => value === original)).toHaveLength(1);
    expect(embeddedValues.filter(value => value === variant)).toHaveLength(1);
    expect(embeddedValues).toHaveLength(2);
  });
});
