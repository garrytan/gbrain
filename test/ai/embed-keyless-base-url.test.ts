/**
 * #4385 — keyless local OpenAI-compatible embedding via OPENAI_BASE_URL.
 *
 * A configured OPENAI_BASE_URL points the native-openai embedding path at a
 * local OpenAI-compatible server (LM Studio, vLLM) that needs no real key —
 * the SDK only requires a non-empty string. Pins:
 *  - embed() with OPENAI_BASE_URL set and no OPENAI_API_KEY does not throw
 *    AIConfigError (the base-URL override satisfies the key requirement).
 *  - diagnoseEmbedding() reports ok under the same config, so the
 *    sync/embed/import credential preflight passes too.
 *  - With neither key nor base URL, both paths still fail closed.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  diagnoseEmbedding,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

// The issue's exact configuration: LM Studio serving a qwen3 embedding model.
const LOCAL_BASE_URL = 'http://127.0.0.1:1234/v1';
const MODEL = 'openai:text-embedding-qwen3-embedding-0.6b';
const DIMS = 1024;

function configureWith(env: Record<string, string | undefined>): void {
  configureGateway({
    embedding_model: MODEL,
    embedding_dimensions: DIMS,
    env,
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

describe('keyless embedding via OPENAI_BASE_URL (#4385)', () => {
  test('embed() succeeds with OPENAI_BASE_URL set and no OPENAI_API_KEY', async () => {
    configureWith({ OPENAI_BASE_URL: LOCAL_BASE_URL });
    __setEmbedTransportForTests((async (args: any) =>
      fakeEmbeddings(args.values.length, DIMS)) as any);
    const vectors = await embed(['hello']);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0].length).toBe(DIMS);
  });

  test('embed() still fails closed with neither key nor base URL', async () => {
    configureWith({});
    __setEmbedTransportForTests((async (args: any) =>
      fakeEmbeddings(args.values.length, DIMS)) as any);
    await expect(embed(['hello'])).rejects.toThrow(AIConfigError);
    await expect(embed(['hello'])).rejects.toThrow(/OPENAI_API_KEY/);
  });

  // No transport stub here: diagnoseEmbedding's test-transport fast path
  // would short-circuit to ok and mask the credential logic under test.
  test('diagnoseEmbedding: base-URL override satisfies the key requirement', () => {
    configureWith({ OPENAI_BASE_URL: LOCAL_BASE_URL });
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(true);
  });

  test('diagnoseEmbedding: neither key nor base URL → missing_env', () => {
    configureWith({});
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d).toMatchObject({
        reason: 'missing_env',
        missingEnvVars: ['OPENAI_API_KEY'],
      });
    }
  });
});
