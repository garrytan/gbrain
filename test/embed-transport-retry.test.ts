/**
 * Embedding transport retry (gateway).
 *
 * Pins the v0.41+ gap that let a flaky embedding relay's intermittent
 * incomplete-cert-chain (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`) fail the
 * *synchronous* MCP put_page embed with no retry behind it:
 *   - transient TLS / connection errors are retried, then succeed
 *   - retries are bounded (give up + surface the error)
 *   - HTTP-status errors (4xx/5xx) are NOT retried here (SDK + normalizeAIError
 *     own those)
 *
 * Uses the __setEmbedTransportForTests seam so the retry path is exercised
 * deterministically without live network flakiness.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  embed,
  isRetryableEmbedTransportError,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

// Keep inter-attempt sleeps sub-millisecond so the retry tests stay fast;
// pin the retry budget to the default by clearing any ambient override.
const FAST_RETRY_ENV = {
  GBRAIN_EMBED_RETRY_BASE_MS: '1',
  GBRAIN_EMBED_TRANSPORT_RETRIES: undefined,
} as const;

/** The shape undici produces: TypeError('fetch failed') wrapping the OpenSSL cause. */
function certChainError(): Error {
  const cause = Object.assign(
    new Error('unable to verify the first certificate'),
    { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
  );
  return Object.assign(new TypeError('fetch failed'), { cause });
}

function okResult(values: string[], dims = 1536) {
  return {
    embeddings: values.map(() => new Array(dims).fill(0).map((_, i) => i * 0.001)),
    usage: { tokens: 0 },
  } as any;
}

function configure() {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
}

beforeEach(() => {
  resetGateway();
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('embed transport retry', () => {
  test('retries a transient cert-chain error then succeeds', async () => {
    configure();
    let calls = 0;
    __setEmbedTransportForTests(async ({ values }: any) => {
      calls++;
      if (calls <= 2) throw certChainError();
      return okResult(values);
    });

    const out = await withEnv(FAST_RETRY_ENV, () => embed(['hello']));
    expect(out.length).toBe(1);
    expect(out[0].length).toBe(1536);
    expect(calls).toBe(3); // 2 failures + 1 success
  });

  test('gives up after exhausting the retry budget', async () => {
    configure();
    let calls = 0;
    __setEmbedTransportForTests(async () => {
      calls++;
      throw certChainError();
    });

    await expect(withEnv(FAST_RETRY_ENV, () => embed(['hello']))).rejects.toThrow();
    expect(calls).toBe(3); // default 2 retries = 3 attempts
  });

  test('honors GBRAIN_EMBED_TRANSPORT_RETRIES=0 (no retry)', async () => {
    configure();
    let calls = 0;
    __setEmbedTransportForTests(async () => {
      calls++;
      throw certChainError();
    });

    await expect(
      withEnv({ ...FAST_RETRY_ENV, GBRAIN_EMBED_TRANSPORT_RETRIES: '0' }, () => embed(['hello'])),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test('does NOT retry an HTTP-status error (401)', async () => {
    configure();
    let calls = 0;
    __setEmbedTransportForTests(async () => {
      calls++;
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    });

    await expect(embed(['hello'])).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test('predicate classifies transport vs status errors', () => {
    expect(isRetryableEmbedTransportError(certChainError())).toBe(true);
    expect(
      isRetryableEmbedTransportError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })),
    ).toBe(true);
    // 5xx carries a status -> handled by the SDK retry path, not here.
    expect(
      isRetryableEmbedTransportError(Object.assign(new Error('bad gateway'), { statusCode: 502 })),
    ).toBe(false);
    // A plain config error is not a transport blip.
    expect(isRetryableEmbedTransportError(new Error('dim mismatch'))).toBe(false);
  });
});
