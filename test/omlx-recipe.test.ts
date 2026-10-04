/**
 * oMLX recipe — multimodal embeddings compat fetch.
 *
 * oMLX's /v1/embeddings rejects OpenAI content-array `input` entries
 * ("Input should be a valid string") and instead takes structured
 * `items: [{text}, {image}]` (omlx #369/#373). The recipe ships a compat
 * fetch that rewrites gbrain's multimodal request body into that shape.
 * This test pins the rewrite contract and the fail-open guarantee.
 */

import { describe, test, expect } from 'bun:test';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { omlxEmbeddingsCompatFetch } from '../src/core/ai/recipes/omlx.ts';

async function captureRewrittenBody(body: unknown): Promise<any> {
  // Point the shim at a URL whose fetch we intercept via a local stub server.
  // Simpler: call the shim against an unreachable URL and inspect what it
  // would have sent by monkey-patching globalThis.fetch for one call.
  const original = globalThis.fetch;
  let captured: any = null;
  globalThis.fetch = (async (_input: any, init?: any) => {
    captured = init?.body ? JSON.parse(init.body) : null;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    await omlxEmbeddingsCompatFetch('http://127.0.0.1:1/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

describe('oMLX recipe — registry shape', () => {
  test('registered with openai-compatible implementation', () => {
    const r = getRecipe('omlx');
    expect(r).toBeDefined();
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.compat?.fetch).toBe(omlxEmbeddingsCompatFetch);
  });

  test('declares multimodal-capable VL embedding models', () => {
    const tp = getRecipe('omlx')!.touchpoints.embedding!;
    expect(tp.supports_multimodal).toBe(true);
    expect(tp.multimodal_models).toContain('Qwen3-VL-Embedding-2B-mlx');
    expect(tp.model_dims?.['Qwen3-VL-Embedding-2B-mlx']).toBe(1024);
  });
});

describe('omlxEmbeddingsCompatFetch — body rewrite', () => {
  test('rewrites image_url content-array input into items:[{image}]', async () => {
    const sent = await captureRewrittenBody({
      model: 'Qwen3-VL-Embedding-2B-mlx',
      input: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
      input_type: 'document',
      dimensions: 1024,
    });
    expect(sent.input).toBeUndefined();
    expect(sent.items).toEqual([{ image: 'data:image/png;base64,AAAA' }]);
    expect(sent.model).toBe('Qwen3-VL-Embedding-2B-mlx');
    expect(sent.dimensions).toBe(1024);
  });

  test('injects Matryoshka dimensions when the caller omits them', async () => {
    const sent = await captureRewrittenBody({
      model: 'Qwen3-VL-Embedding-2B-mlx',
      input: [{ type: 'input_text', text: 'no dims here' }],
    });
    // oMLX defaults to native width (2048 for VL-2B); the shim pins 1024 so
    // the vector matches the brain's column.
    expect(sent.dimensions).toBe(1024);
  });

  test('rewrites input_text content-array input into items:[{text}]', async () => {
    const sent = await captureRewrittenBody({
      model: 'Qwen3-VL-Embedding-2B-mlx',
      input: [{ type: 'input_text', text: 'hello world' }],
    });
    expect(sent.input).toBeUndefined();
    expect(sent.items).toEqual([{ text: 'hello world' }]);
  });

  test('leaves plain-string input untouched (text embedding fast path)', async () => {
    const sent = await captureRewrittenBody({
      model: 'Qwen3-Embedding-0.6B-mxfp8',
      input: ['plain text', 'another string'],
    });
    expect(sent.input).toEqual(['plain text', 'another string']);
    expect(sent.items).toBeUndefined();
  });

  test('fail-open: unparseable body passes through untouched', async () => {
    const original = globalThis.fetch;
    let capturedRaw: any = null;
    globalThis.fetch = (async (_input: any, init?: any) => {
      capturedRaw = init?.body;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await omlxEmbeddingsCompatFetch('http://127.0.0.1:1/v1/embeddings', {
        method: 'POST',
        body: 'not json {{{',
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(capturedRaw).toBe('not json {{{');
  });
});
