/**
 * v0.36.0.0 (D8 + D17) — Asymmetric encoding contract.
 *
 * Pins that the search read path (hybridSearch + expansion) uses
 * `gateway.embedQuery()` for user-supplied query strings, which threads
 * `inputType: 'query'` through `dimsProviderOptions`. Index-side writes
 * use `gateway.embed()` with default 'document' encoding.
 *
 * Why this test exists (D17):
 *   The original audit was a source-text grep — fragile under refactors
 *   that rename `gateway` to `gw` or alias-import `{ embed }`. These tests
 *   use the `__setEmbedTransportForTests` mock to capture the provider
 *   options the transport sees, both for the gateway primitives and for
 *   `embedQueryBounded` — the helper both hybridSearch query-embed call
 *   sites go through — and assert the query call carries
 *   `input_type: 'query'`.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  embedQuery,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { embedQueryBounded, makeQueryEmbedDeadline } from '../src/core/search/hybrid.ts';

function configureVoyage() {
  configureGateway({
    embedding_model: 'voyage:voyage-4',
    embedding_dimensions: 1024,
    env: { VOYAGE_API_KEY: 'sk-fake' },
  });
}

function fakeEmbeddings(count: number, dims: number) {
  return {
    embeddings: Array.from({ length: count }, () =>
      Array.from({ length: dims }, () => 0.1),
    ),
  };
}

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('Search read path uses embedQuery (D17 behavior contract)', () => {
  test('embedQuery threads input_type=query through transport for Voyage', async () => {
    configureVoyage();
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(1, 1024);
    }) as any);

    await embedQuery('what does foo bar do?');
    expect(capturedOpts?.openaiCompatible?.input_type).toBe('query');
  });

  test('embed (index path) threads input_type=document for Voyage', async () => {
    configureVoyage();
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(args.values.length, 1024);
    }) as any);

    await embed(['this is a document being indexed'], { inputType: 'document' });
    expect(capturedOpts?.openaiCompatible?.input_type).toBe('document');
  });
});

describe('hybridSearch query embedding uses query encoding', () => {
  test('embedQueryBounded sends input_type=query for Voyage', async () => {
    configureVoyage();
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(1, 1024);
    }) as any);

    await embedQueryBounded('what does foo bar do?', undefined, makeQueryEmbedDeadline());
    expect(capturedOpts?.openaiCompatible?.input_type).toBe('query');
  });
});

describe('Symmetric providers ignore input_type (OpenAI regression guard)', () => {
  test('OpenAI text-embedding-3-large produces no input_type field', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1024,
      env: { OPENAI_API_KEY: 'sk-fake' },
    });
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(1, 1024);
    }) as any);

    await embedQuery('hello');
    // OpenAI is symmetric — input_type would be rejected by the API.
    expect(JSON.stringify(capturedOpts)).not.toContain('input_type');
  });
});
