// #4616 coverage audit — assertIndexableEmbedding at its three call sites.
// gateway.test.ts pins zero-norm + NaN on the text path (embedSubBatch); this
// file pins the two claims that block leaves open: the norm is taken on the
// float32 view (what the vector column stores), the guard's AIConfigError does
// NOT enter the token-limit halving retry, and both multimodal paths (Voyage
// native /multimodalembeddings, openai-compat /embeddings) are guarded too.
import { afterAll, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  embedMultimodal,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

const origFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = origFetch;
  __setEmbedTransportForTests(null);
  resetGateway();
});

const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

test('1e-50 components (non-zero in float64, zero at float32) are rejected as zero-norm after ONE transport call — no halving retry', async () => {
  let calls = 0;
  __setEmbedTransportForTests(async ({ values }: any) => {
    calls += 1;
    return { embeddings: values.map(() => new Array(1536).fill(1e-50)), usage: { tokens: 0 } } as any;
  });
  try {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'openai-fake' },
    });
    const err = await rejection(embed(['first', 'second']));
    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as Error).message).toContain('zero-norm');
    // A float64 norm would be ~1.5e-97 > 0 and pass; float32 flushes 1e-50 to 0.
    // One call for a 2-text batch: the AIConfigError is not a token-limit
    // error, so embedSubBatch rethrows instead of halving and re-asking.
    expect(calls).toBe(1);
  } finally {
    __setEmbedTransportForTests(null);
    resetGateway();
  }
}, 60_000);

test('embedMultimodal rejects a degenerate vector on the Voyage-native path (zero-norm) and the openai-compat path (Infinity → non-finite)', async () => {
  const jsonResponse = (bodyText: string) => (async () =>
    new Response(bodyText, { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  const image = [{ kind: 'image_base64' as const, data: 'x', mime: 'image/png' }];
  try {
    // Voyage native: an all-zero 1024-d vector.
    globalThis.fetch = jsonResponse(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0), index: 0 }] }));
    configureGateway({
      embedding_model: 'voyage:voyage-multimodal-3',
      embedding_dimensions: 1024,
      env: { VOYAGE_API_KEY: 'test-key' },
    });
    let err = await rejection(embedMultimodal(image));
    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as Error).message).toContain('zero-norm');
    expect((err as Error).message).toContain('voyage-multimodal-3');
    resetGateway();

    // openai-compat: JSON cannot carry NaN (it would arrive as null → 0), but
    // `1e999` parses to Infinity, so the norm is Infinity → 'non-finite'.
    const comps = new Array(1024).fill('0.01');
    comps[3] = '1e999';
    globalThis.fetch = jsonResponse(`{"data":[{"embedding":[${comps.join(',')}],"index":0}]}`);
    configureGateway({
      embedding_model: 'litellm:gpt-4o-multimodal',
      embedding_dimensions: 1024,
      env: { LITELLM_API_KEY: 'test-litellm-key', LITELLM_BASE_URL: 'http://localhost:4000' },
      base_urls: { litellm: 'http://localhost:4000' },
    });
    err = await rejection(embedMultimodal(image));
    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as Error).message).toContain('non-finite');
    expect((err as Error).message).toContain('gpt-4o-multimodal');
  } finally {
    globalThis.fetch = origFetch;
    resetGateway();
  }
}, 60_000);
