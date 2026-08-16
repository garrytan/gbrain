/**
 * v0.46.3 — once-per-process sunset warn-on-use.
 *
 * A recipe with `sunset` metadata warns on stderr the first time each
 * touchpoint is actually used, exactly once per (recipe, touchpoint), with a
 * paste-ready replacement command. Driven through the rerank path (the
 * embedding path shares the same warnSunsetOnce helper) with the stubbed
 * rerank transport. `_resetSunsetWarningsForTest` is the seam.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  rerank,
  __setRerankTransportForTests,
  _resetSunsetWarningsForTest,
} from '../../src/core/ai/gateway.ts';

function mockResp(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let stderrChunks: string[] = [];
let origWrite: typeof process.stderr.write;

beforeEach(() => {
  _resetSunsetWarningsForTest();
  stderrChunks = [];
  origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  configureGateway({
    reranker_model: 'zeroentropyai:zerank-2',
    env: { ZEROENTROPY_API_KEY: 'sk-test-zerokey' },
  });
  __setRerankTransportForTests(async () =>
    mockResp({ results: [{ index: 0, relevance_score: 0.9 }] }),
  );
});

afterEach(() => {
  process.stderr.write = origWrite;
  __setRerankTransportForTests(null);
  _resetSunsetWarningsForTest();
  resetGateway();
});

describe('sunset warn-on-use (v0.46.3)', () => {
  test('first ZE rerank prints the deprecation warning with the replacement command', async () => {
    await rerank({ query: 'q', documents: ['a'] });
    const all = stderrChunks.join('');
    expect(all).toContain('DEPRECATED');
    expect(all).toContain('2026-09-04');
    expect(all).toContain('search.reranker.model voyage:rerank-2.5');
  });

  test('fires once per process, not once per call', async () => {
    await rerank({ query: 'q', documents: ['a'] });
    await rerank({ query: 'q2', documents: ['b'] });
    const hits = stderrChunks.join('').split('DEPRECATED').length - 1;
    expect(hits).toBe(1);
  });

  test('reset seam re-arms the warning', async () => {
    await rerank({ query: 'q', documents: ['a'] });
    _resetSunsetWarningsForTest();
    await rerank({ query: 'q2', documents: ['b'] });
    const hits = stderrChunks.join('').split('DEPRECATED').length - 1;
    expect(hits).toBe(2);
  });

  test('a non-sunset provider warns nothing', async () => {
    resetGateway();
    configureGateway({
      reranker_model: 'voyage:rerank-2.5',
      env: { VOYAGE_API_KEY: 'pa-test' },
    });
    await rerank({ query: 'q', documents: ['a'] });
    expect(stderrChunks.join('')).not.toContain('DEPRECATED');
  });
});

describe('sunset warn-on-use — embedding touchpoint (v0.46.3)', () => {
  test('first ZE embed resolution warns with the migrate command', async () => {
    _resetSunsetWarningsForTest();
    stderrChunks = [];
    resetGateway();
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { ZEROENTROPY_API_KEY: 'sk-test-zerokey' },
    });
    const { __setEmbedTransportForTests, embedQuery } = await import('../../src/core/ai/gateway.ts');
    __setEmbedTransportForTests(async (args: any) => ({
      embeddings: args.values.map(() => Array.from({ length: 1280 }, () => 0.01)),
    }) as any);
    try {
      await embedQuery('hello');
    } finally {
      __setEmbedTransportForTests(null);
    }
    const all = stderrChunks.join('');
    expect(all).toContain('DEPRECATED');
    expect(all).toContain('migrate embeddings --to voyage:voyage-4');
  });
});
