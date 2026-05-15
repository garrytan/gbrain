/**
 * v0.35.0.0 — embedQuery() routing tests.
 *
 * Pins:
 *  - embedQuery returns a single Float32Array (not a batch).
 *  - embedQuery threads inputType='query' through dimsProviderOptions
 *    into the provider options blob that reaches embedMany().
 *  - embed() (without inputType arg) defaults to no input_type field for
 *    back-compat. This is the contract the dimsProviderOptions 4th-arg
 *    audit relies on: existing callers continue to embed as 'document'-
 *    side without a code change.
 *  - For symmetric providers (OpenAI text-3, DashScope), embedQuery does
 *    NOT inject input_type into the provider options (CDX2-F6 per-model
 *    filtering pinned at the dims-zeroentropy.test.ts layer; this test
 *    confirms the gateway end-to-end stays consistent).
 *  - For ZE zembed-1, embedQuery produces input_type='query'.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  embedQuery,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';

function configureZE(): void {
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: 2560,
    env: { ZEROENTROPY_API_KEY: 'sk-fake' },
  });
}

function configureOpenAI(): void {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
}

function configureVoyage(): void {
  configureGateway({
    embedding_model: 'voyage:voyage-3-large',
    embedding_dimensions: 1024,
    env: { VOYAGE_API_KEY: 'sk-fake' },
  });
}

function fakeEmbeddings(count: number, dims: number) {
  return {
    embeddings: Array.from({ length: count }, (_, i) =>
      Array.from({ length: dims }, (_, j) => (j === 0 ? i : 0.1)),
    ),
  };
}

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('embedQuery — return shape', () => {
  beforeEach(() => configureZE());

  test('returns a single Float32Array (not a batch)', async () => {
    __setEmbedTransportForTests((async () => fakeEmbeddings(1, 2560)) as any);
    const v = await embedQuery('hello');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(2560);
    // Index sentinel matches input position 0.
    expect(v[0]).toBe(0);
  });
});

describe('embedQuery — inputType plumbing (ZE asymmetric)', () => {
  beforeEach(() => configureZE());

  test('embedQuery sends input_type=query in providerOptions', async () => {
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(1, 2560);
    }) as any);
    await embedQuery('hello');
    expect(capturedOpts?.openaiCompatible?.input_type).toBe('query');
    expect(capturedOpts?.openaiCompatible?.dimensions).toBe(2560);
  });

  test('embed() (no inputType arg) sends input_type=document for ZE', async () => {
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(args.values.length, 2560);
    }) as any);
    await embed(['doc']);
    expect(capturedOpts?.openaiCompatible?.input_type).toBe('document');
  });

  test('embed([…], "query") explicit threading also reaches the wire', async () => {
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(args.values.length, 2560);
    }) as any);
    await embed(['q1', 'q2'], { inputType: 'query' });
    expect(capturedOpts?.openaiCompatible?.input_type).toBe('query');
  });
});

describe('embedQuery — per-model filtering (CDX2-F6, end-to-end)', () => {
  test('OpenAI text-embedding-3-large: NO input_type in providerOptions', async () => {
    configureOpenAI();
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(1, 1536);
    }) as any);
    await embedQuery('hello');
    // OpenAI's /embeddings endpoint would reject an unexpected input_type
    // field. The CDX2-F6 fix puts the ZE/Voyage branches BEFORE the generic
    // text-embedding-3 fall-through; this end-to-end test pins the absence.
    expect(capturedOpts?.openai?.dimensions).toBe(1536);
    expect(JSON.stringify(capturedOpts)).not.toContain('input_type');
  });

  test('Voyage voyage-3-large: input_type=query reaches the wire', async () => {
    configureVoyage();
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(1, 1024);
    }) as any);
    await embedQuery('hello');
    // Voyage v3+ accepts input_type; embedQuery threading reaches it.
    expect(capturedOpts?.openaiCompatible?.input_type).toBe('query');
    expect(capturedOpts?.openaiCompatible?.dimensions).toBe(1024);
  });

  test('Voyage with embed() (no inputType arg): NO input_type field (back-compat)', async () => {
    configureVoyage();
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(args.values.length, 1024);
    }) as any);
    await embed(['doc']);
    // CDX2-F6 contract: legacy callers (no 4th-arg) preserve their existing
    // behavior. The pre-v0.35.0.0 Voyage gateway never sent input_type;
    // a regression here would break existing brains. The condition is
    // tested at the dimsProviderOptions layer too, but this end-to-end pin
    // catches a future refactor that might bypass the condition.
    expect(JSON.stringify(capturedOpts)).not.toContain('input_type');
  });
});

describe('embedQuery — routes through same recipe as embed', () => {
  beforeEach(() => configureZE());

  test('embedQuery + embed both use the configured ZE model', async () => {
    const dimsSeen: number[] = [];
    __setEmbedTransportForTests((async (args: any) => {
      // The args.model in the AI-SDK transport is the model instance; we
      // can stringify a canonical name via the provider/recipe — easier
      // to just confirm the dims and providerOptions match the ZE config.
      dimsSeen.push(args.providerOptions?.openaiCompatible?.dimensions);
      return fakeEmbeddings(args.values.length, 2560);
    }) as any);
    await embedQuery('q');
    await embed(['d']);
    // Both calls routed through the same recipe + dim config.
    expect(dimsSeen).toEqual([2560, 2560]);
  });
});
