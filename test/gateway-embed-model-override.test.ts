/**
 * v0.36 (D10) — gateway embed model override path.
 *
 * Pins:
 *   - embedQuery(text, { embeddingModel }) routes through THAT provider,
 *     not the global default.
 *   - embedQuery(text, { dimensions }) flows into dimsProviderOptions
 *     so providers that accept output_dimension see the override.
 *   - Bare embedQuery(text) continues to use the configured default.
 *   - Unknown override model throws (resolveEmbeddingProvider's
 *     AIConfigError shape with a hint).
 *   - isAvailable('embedding', modelOverride) probes the override's
 *     recipe, not the global default's.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  embedQuery,
  isAvailable,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

interface TransportCall {
  modelString: string;
  values: string[];
  providerOptions: Record<string, unknown>;
}

const calls: TransportCall[] = [];

function installCaptureTransport(makeVector: (dims: number) => number[]) {
  __setEmbedTransportForTests(async ({ model, values, providerOptions }: any) => {
    // The AI SDK's `model` object exposes `.modelId` (string) on every
    // openai-compatible model. We capture it so tests can assert the
    // gateway routed to the correct provider:model.
    const modelString = (model?.modelId ?? '<unknown>') as string;
    calls.push({ modelString, values: [...values], providerOptions: { ...(providerOptions ?? {}) } });
    // Pick the dim from providerOpts when present (Voyage flexible-dim
    // path emits openaiCompatible.dimensions); otherwise default 1536.
    const oc = (providerOptions?.openaiCompatible ?? {}) as Record<string, unknown>;
    const dims = typeof oc.dimensions === 'number' ? (oc.dimensions as number) : 1536;
    return {
      embeddings: values.map(() => makeVector(dims)),
      usage: { tokens: 0 },
    } as any;
  });
}

beforeEach(() => {
  calls.length = 0;
  resetGateway();
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('embedQuery — bare (no opts)', () => {
  test('bare call uses the globally configured embedding_model', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    installCaptureTransport(d => new Array(d).fill(0).map((_, i) => i * 0.001));

    const v = await embedQuery('hello');
    expect(v.length).toBe(1536);
    expect(calls.length).toBe(1);
    expect(calls[0].modelString).toBe('text-embedding-3-large');
  });
});

describe('embedQuery — { embeddingModel } override', () => {
  test('routes through the override provider, not the global default', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'voy-test' },
    });
    installCaptureTransport(d => new Array(d).fill(0).map((_, i) => i * 0.002));

    const v = await embedQuery('hello', {
      embeddingModel: 'voyage:voyage-3-large',
      dimensions: 1024,
    });
    expect(v.length).toBe(1024);
    expect(calls.length).toBe(1);
    expect(calls[0].modelString).toBe('voyage-3-large');
  });

  test('dimensions override flows into providerOptions', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'voy-test' },
    });
    installCaptureTransport(d => new Array(d).fill(0).map(() => 0.1));

    await embedQuery('hello', { embeddingModel: 'voyage:voyage-3-large', dimensions: 2048 });
    const opts = calls[0].providerOptions as { openaiCompatible?: Record<string, unknown> };
    // Voyage flexible-dim models emit `dimensions` into the openaiCompatible
    // providerOptions block; the shim translates to output_dimension on
    // the wire. Either way, the gateway honored the caller's dim override.
    expect(opts.openaiCompatible).toBeDefined();
    expect(opts.openaiCompatible!.dimensions).toBe(2048);
  });

  test('unknown override model throws AIConfigError with a useful hint', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    installCaptureTransport(d => new Array(d).fill(0));

    let threw: Error | null = null;
    try {
      await embedQuery('hello', { embeddingModel: 'nonexistent:bogus' });
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).toBeTruthy();
    // Error message names the provider or model so the user knows what failed.
    expect(threw!.message.toLowerCase()).toMatch(/nonexistent|provider|recipe|model/);
  });
});

describe('isAvailable(touchpoint, modelOverride) — D10', () => {
  test('global default available + Voyage override key present → both available', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'voy-test' },
    });
    expect(isAvailable('embedding')).toBe(true);
    expect(isAvailable('embedding', 'voyage:voyage-3-large')).toBe(true);
  });

  test('global default key missing but override key present → override is available', () => {
    // The single-OPENAI scenario: user removed OPENAI_API_KEY but
    // configured Voyage for the alt column. Pre-D10, isAvailable would
    // have said embedding is unavailable globally and hybridSearch
    // would skip vector search ENTIRELY. With the override, hybrid asks
    // about the active column's provider and gets a green light.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { VOYAGE_API_KEY: 'voy-test' }, // no OPENAI_API_KEY
    });
    expect(isAvailable('embedding')).toBe(false);
    expect(isAvailable('embedding', 'voyage:voyage-3-large')).toBe(true);
  });

  test('global default available but override key missing → override is unavailable', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' }, // no VOYAGE_API_KEY
    });
    expect(isAvailable('embedding')).toBe(true);
    expect(isAvailable('embedding', 'voyage:voyage-3-large')).toBe(false);
  });

  test('override against an unknown model returns false', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    expect(isAvailable('embedding', 'totally:unknown')).toBe(false);
  });
});
