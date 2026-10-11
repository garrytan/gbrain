import { afterAll, beforeEach, expect, test } from 'bun:test';
import { embedBatch } from '../src/core/embedding.ts';
import { embedBatchKeepingUsable, embedBatchWithBackoff } from '../src/core/embed-retry.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const DIMS = 768;
const TITLE = 'Real page title';
let calls: string[][] = [];
let mode: 'normal' | 'transient-once' | 'refuse-middle' = 'normal';

configureGateway({ embedding_model: 'ollama:embeddinggemma:latest', embedding_dimensions: DIMS, env: { OLLAMA_API_KEY: 'test' } });
__setEmbedTransportForTests(async input => {
  calls.push(input.values);
  if (mode === 'transient-once' && calls.length === 1) throw new Error('fetch failed');
  return {
    embeddings: input.values.map(value => new Array<number>(DIMS).fill(mode === 'refuse-middle' && value.includes('chunk 1') ? 0 : 0.1)),
    values: input.values,
    warnings: [],
    usage: { tokens: input.values.length },
  };
});

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

beforeEach(() => {
  calls = [];
  mode = 'normal';
});

test('embedBatch keeps a document title across pagination and progress callbacks', async () => {
  const texts = Array.from({ length: 205 }, (_, i) => `chunk ${i}`);
  const progress: number[] = [];

  await embedBatch(texts, { documentTitle: TITLE, onBatchComplete: done => progress.push(done) });

  expect(progress).toEqual([100, 200, 205]);
  expect(calls.flat()).toEqual(texts.map(text => `title: ${TITLE} | text: ${text}`));
});

test('transient retry sends the same singly formatted document input', async () => {
  mode = 'transient-once';
  const text = 'the raw chunk';

  await embedBatchWithBackoff([text], { documentTitle: TITLE });

  expect(calls).toEqual([[`title: ${TITLE} | text: ${text}`], [`title: ${TITLE} | text: ${text}`]]);
});

test('keeping usable embeddings preserves refusal alignment with document metadata', async () => {
  mode = 'refuse-middle';
  const texts = ['chunk 0', 'chunk 1', 'chunk 2'];

  const result = await embedBatchKeepingUsable(texts, { documentTitle: TITLE });

  expect(calls).toEqual([texts.map(text => `title: ${TITLE} | text: ${text}`)]);
  expect(result.vectors.map(vector => vector === null)).toEqual([false, true, false]);
  expect(result.refused?.failures).toEqual([{ index: 1, reason: 'zero_norm' }]);
});
