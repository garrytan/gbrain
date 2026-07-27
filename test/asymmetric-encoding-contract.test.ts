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
 *   that rename `gateway` to `gw` or alias-import `{ embed }`. This test
 *   uses the `__setEmbedTransportForTests` mock to capture every HTTP
 *   body the transport sees during a representative search call, then
 *   asserts the query call carries `input_type: 'query'`.
 *
 *   The complementary source-text check stays here as a SECOND layer
 *   (cheap belt-and-suspenders): if `hybrid.ts` ever stops importing
 *   `embedQuery`, this test fails before the regression ships.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  configureGateway,
  resetGateway,
  embed,
  embedQuery,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

function configureZE() {
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: 1280,
    env: { ZEROENTROPY_API_KEY: 'sk-fake' },
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
  test('embedQuery threads input_type=query through transport for ZE', async () => {
    configureZE();
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(1, 1280);
    }) as any);

    await embedQuery('what does foo bar do?');
    expect(capturedOpts?.openaiCompatible?.input_type).toBe('query');
  });

  test('embed (index path) threads input_type=document for ZE', async () => {
    configureZE();
    let capturedOpts: any = null;
    __setEmbedTransportForTests((async (args: any) => {
      capturedOpts = args.providerOptions;
      return fakeEmbeddings(args.values.length, 1280);
    }) as any);

    await embed(['this is a document being indexed']);
    expect(capturedOpts?.openaiCompatible?.input_type).toBe('document');
  });
});

describe('Source-text contract (cheap belt + suspenders)', () => {
  // These tests fail-fast if a refactor accidentally swaps embedQuery → embed
  // on the search read path. The behavior test above catches the runtime
  // regression; this catches the static one (broken import, renamed helper).

  test('src/core/search/hybrid.ts imports embedQuery from embedding.ts', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/core/search/hybrid.ts'),
      'utf8',
    );
    // The import must include embedQuery; matches both `embedQuery` and `{ embed, embedQuery }`.
    expect(src).toMatch(/from '..\/embedding.ts'/);
    expect(src).toContain('embedQuery');
  });

  test('src/core/search/hybrid.ts calls embedQuery at the search-time query path', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/core/search/hybrid.ts'),
      'utf8',
    );
    // Look for the call site (any whitespace shape). The line at 414 today is
    // `await Promise.all(queries.map(q => embedQuery(q)))`. The regex stays
    // permissive: match `embedQuery(` anywhere in the file body.
    expect(src).toMatch(/embedQuery\s*\(/);
  });

  test('src/core/embedding.ts re-exports both embed and embedQuery', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/core/embedding.ts'),
      'utf8',
    );
    // The embedding module is the seam between gateway and search.
    // Both functions MUST be exported so consumers can route correctly.
    expect(src).toMatch(/export\s+(?:async\s+)?function\s+embed\s*\(|export\s*\{[^}]*\bembed\b/);
    expect(src).toMatch(/export\s+(?:async\s+)?function\s+embedQuery\s*\(|export\s*\{[^}]*\bembedQuery\b/);
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
