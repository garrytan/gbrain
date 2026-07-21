/**
 * #2552: cloud-tuned embedding defaults silently wedge CPU-only local
 * endpoints (Ollama). Three-part fix under test:
 *
 *  1. `isLocalEmbeddingEndpoint()` — gateway helper detecting local
 *     inference servers (ollama / llama-server recipes, localhost base URL).
 *  2. `resolveEmbedConcurrency()` — embed auto-caps the 20-worker fan-out
 *     at LOCAL_EMBED_CONCURRENCY_CAP for local endpoints unless the
 *     operator set GBRAIN_EMBED_CONCURRENCY explicitly.
 *  3. `computeEmbedConcurrencyCheck()` — doctor warns when an explicit env
 *     override fans out against a local endpoint.
 *
 * Serial: mutates process.env and the module-global gateway config.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  isLocalEmbeddingEndpoint,
  LOCAL_EMBED_CONCURRENCY_CAP,
} from '../src/core/ai/gateway.ts';
import { resolveEmbedConcurrency } from '../src/commands/embed.ts';
import { computeEmbedConcurrencyCheck } from '../src/commands/doctor.ts';

const SAVED_ENV = process.env.GBRAIN_EMBED_CONCURRENCY;

afterEach(() => {
  resetGateway();
  if (SAVED_ENV === undefined) delete process.env.GBRAIN_EMBED_CONCURRENCY;
  else process.env.GBRAIN_EMBED_CONCURRENCY = SAVED_ENV;
});

afterAll(() => {
  resetGateway();
});

describe('#2552 isLocalEmbeddingEndpoint', () => {
  test('false when the gateway is not configured (fail-open to cloud behavior)', () => {
    resetGateway();
    expect(isLocalEmbeddingEndpoint()).toBe(false);
  });

  test('true for the ollama recipe', () => {
    configureGateway({ embedding_model: 'ollama:nomic-embed-text', env: {} });
    expect(isLocalEmbeddingEndpoint()).toBe(true);
  });

  test('true for the llama-server recipe', () => {
    configureGateway({ embedding_model: 'llama-server:my-gguf', env: {} });
    expect(isLocalEmbeddingEndpoint()).toBe(true);
  });

  test('false for a cloud recipe', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      env: { OPENAI_API_KEY: 'fake' },
    });
    expect(isLocalEmbeddingEndpoint()).toBe(false);
  });

  test('true when a cloud recipe base URL is explicitly pointed at localhost', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      env: { OPENAI_API_KEY: 'fake' },
      base_urls: { openai: 'http://localhost:8080/v1' },
    });
    expect(isLocalEmbeddingEndpoint()).toBe(true);
  });
});

describe('#2552 resolveEmbedConcurrency', () => {
  test('caps at LOCAL_EMBED_CONCURRENCY_CAP for a local endpoint when env is unset', () => {
    delete process.env.GBRAIN_EMBED_CONCURRENCY;
    configureGateway({ embedding_model: 'ollama:nomic-embed-text', env: {} });
    expect(resolveEmbedConcurrency()).toBe(LOCAL_EMBED_CONCURRENCY_CAP);
  });

  test('explicit env override always wins, even against a local endpoint', () => {
    process.env.GBRAIN_EMBED_CONCURRENCY = '10';
    configureGateway({ embedding_model: 'ollama:nomic-embed-text', env: {} });
    expect(resolveEmbedConcurrency()).toBe(10);
  });

  test('cloud endpoints keep the historical default of 20', () => {
    delete process.env.GBRAIN_EMBED_CONCURRENCY;
    configureGateway({ env: { OPENAI_API_KEY: 'fake' } });
    expect(resolveEmbedConcurrency()).toBe(20);
  });

  test('pacing only ever lowers concurrency', () => {
    delete process.env.GBRAIN_EMBED_CONCURRENCY;
    configureGateway({ embedding_model: 'ollama:nomic-embed-text', env: {} });
    expect(resolveEmbedConcurrency(1)).toBe(1);
    expect(resolveEmbedConcurrency(16)).toBe(LOCAL_EMBED_CONCURRENCY_CAP);
  });
});

describe('#2552 computeEmbedConcurrencyCheck (doctor)', () => {
  test('ok for non-local endpoints', () => {
    expect(computeEmbedConcurrencyCheck(false, '20', 2).status).toBe('ok');
  });

  test('warn when an explicit override exceeds the local cap', () => {
    const check = computeEmbedConcurrencyCheck(true, '20', 2);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('GBRAIN_EMBED_CONCURRENCY=20');
  });

  test('ok when env is unset against a local endpoint (auto-cap applies)', () => {
    expect(computeEmbedConcurrencyCheck(true, undefined, 2).status).toBe('ok');
  });

  test('ok when the override is at or under the cap', () => {
    expect(computeEmbedConcurrencyCheck(true, '2', 2).status).toBe('ok');
    expect(computeEmbedConcurrencyCheck(true, '1', 2).status).toBe('ok');
  });
});
