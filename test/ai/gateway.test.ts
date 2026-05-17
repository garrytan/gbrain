import { describe, test, expect, beforeEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  isAvailable,
  embed,
  getEmbeddingModel,
  getEmbeddingDimensions,
  getExpansionModel,
  VoyageResponseTooLargeError,
} from '../../src/core/ai/gateway.ts';
import { parseModelId, resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import {
  dimsProviderOptions,
  VOYAGE_VALID_OUTPUT_DIMS,
  isValidVoyageOutputDim,
} from '../../src/core/ai/dims.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('gateway configuration', () => {
  beforeEach(() => resetGateway());

  test('configureGateway sets current models and dims', () => {
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 768,
      expansion_model: 'anthropic:claude-haiku-4-5-20251001',
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' },
    });
    expect(getEmbeddingModel()).toBe('google:gemini-embedding-001');
    expect(getEmbeddingDimensions()).toBe(768);
    expect(getExpansionModel()).toBe('anthropic:claude-haiku-4-5-20251001');
  });

  test('defaults preserve v0.13 OpenAI behavior', () => {
    configureGateway({ env: {} });
    expect(getEmbeddingModel()).toBe('openai:text-embedding-3-large');
    expect(getEmbeddingDimensions()).toBe(1536);
    expect(getExpansionModel()).toBe('anthropic:claude-haiku-4-5-20251001');
  });
});

describe('gateway.isAvailable (silent-drop regression surface)', () => {
  beforeEach(() => resetGateway());

  test('returns false when gateway not configured', () => {
    expect(isAvailable('embedding')).toBe(false);
  });

  test('embedding available when OPENAI_API_KEY set and model is openai', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-fake' },
    });
    expect(isAvailable('embedding')).toBe(true);
  });

  test('embedding UNAVAILABLE when OPENAI_API_KEY missing even if config names openai', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: {},
    });
    expect(isAvailable('embedding')).toBe(false);
  });

  test('embedding AVAILABLE for google when GOOGLE_GENERATIVE_AI_API_KEY set even if OPENAI_API_KEY is NOT (Codex silent-drop regression)', () => {
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 768,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake-google' }, // NOTE: OPENAI_API_KEY deliberately absent
    });
    expect(isAvailable('embedding')).toBe(true);
  });

  test('embedding AVAILABLE for ollama with no API key (local)', () => {
    configureGateway({
      embedding_model: 'ollama:nomic-embed-text',
      embedding_dimensions: 768,
      env: {},
    });
    expect(isAvailable('embedding')).toBe(true);
  });

  test('anthropic rejects embedding touchpoint (has no embedding model)', () => {
    configureGateway({
      embedding_model: 'anthropic:claude-haiku-4-5-20251001',
      embedding_dimensions: 1536,
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    expect(isAvailable('embedding')).toBe(false);
  });

  test('expansion available when ANTHROPIC_API_KEY set', () => {
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5-20251001',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    expect(isAvailable('expansion')).toBe(true);
  });

  test('chat available for LiteLLM user-provided models with no API key', () => {
    configureGateway({
      chat_model: 'litellm:any-upstream-model',
      base_urls: { litellm: 'http://localhost:4000/v1' },
      env: {},
    });
    expect(isAvailable('chat')).toBe(true);
  });
});

describe('model-resolver', () => {
  test('parseModelId splits on first colon', () => {
    expect(parseModelId('openai:text-embedding-3-large')).toEqual({
      providerId: 'openai',
      modelId: 'text-embedding-3-large',
    });
  });

  test('parseModelId handles model ids with colons', () => {
    expect(parseModelId('litellm:azure:gpt-4')).toEqual({
      providerId: 'litellm',
      modelId: 'azure:gpt-4',
    });
  });

  test('parseModelId rejects missing colon', () => {
    expect(() => parseModelId('openai-text-embedding-3-large')).toThrow(AIConfigError);
  });

  test('parseModelId rejects empty provider or model', () => {
    expect(() => parseModelId(':model')).toThrow(AIConfigError);
    expect(() => parseModelId('provider:')).toThrow(AIConfigError);
  });

  test('resolveRecipe finds known providers', () => {
    const { recipe, parsed } = resolveRecipe('openai:text-embedding-3-large');
    expect(recipe.id).toBe('openai');
    expect(parsed.modelId).toBe('text-embedding-3-large');
  });

  test('resolveRecipe throws AIConfigError for unknown provider', () => {
    expect(() => resolveRecipe('cohere:embed-v3')).toThrow(AIConfigError);
  });
});

describe('dims.dimsProviderOptions', () => {
  test('OpenAI text-embedding-3 returns dimensions param', () => {
    const opts = dimsProviderOptions('native-openai', 'text-embedding-3-large', 1536);
    expect(opts).toEqual({ openai: { dimensions: 1536 } });
  });

  test('OpenAI ada-002 returns undefined (no dim param)', () => {
    const opts = dimsProviderOptions('native-openai', 'text-embedding-ada-002', 1536);
    expect(opts).toBeUndefined();
  });

  test('Google gemini-embedding returns outputDimensionality', () => {
    const opts = dimsProviderOptions('native-google', 'gemini-embedding-001', 768);
    expect(opts).toEqual({ google: { outputDimensionality: 768 } });
  });

  test('Anthropic returns undefined (no embedding model)', () => {
    const opts = dimsProviderOptions('native-anthropic', 'claude-haiku-4-5', 1536);
    expect(opts).toBeUndefined();
  });

  test('openai-compatible returns undefined for providers without a dim param', () => {
    const opts = dimsProviderOptions('openai-compatible', 'nomic-embed-text', 768);
    expect(opts).toBeUndefined();
  });

  test('Voyage flexible-dim models return dimensions for the SDK shim', () => {
    const opts = dimsProviderOptions('openai-compatible', 'voyage-3-large', 1024);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
    const v4Opts = dimsProviderOptions('openai-compatible', 'voyage-4-large', 2048);
    expect(v4Opts).toEqual({ openaiCompatible: { dimensions: 2048 } });
  });

  test('Voyage model without flexible dimensions returns undefined', () => {
    const opts = dimsProviderOptions('openai-compatible', 'voyage-3-lite', 1024);
    expect(opts).toBeUndefined();
  });

  // Negative regression pin: voyage-4-nano is an open-weight variant that
  // Voyage's hosted API rejects `output_dimension` on (fixed 1024-dim).
  // Don't re-add it to VOYAGE_OUTPUT_DIMENSION_MODELS without cross-checking
  // Voyage's docs. See src/core/ai/dims.ts for the rationale.
  test('voyage-4-nano returns undefined (open-weight, fixed-dim)', () => {
    const opts = dimsProviderOptions('openai-compatible', 'voyage-4-nano', 512);
    expect(opts).toBeUndefined();
  });
});

describe('Voyage openai-compatible request shim', () => {
  beforeEach(() => resetGateway());

  test('sends output_dimension on the actual Voyage embedding request body', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          {
            object: 'embedding',
            index: 0,
            embedding: new Array(2048).fill(0.01),
          },
        ],
        model: 'voyage-4-large',
        usage: { total_tokens: 3 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      configureGateway({
        embedding_model: 'voyage:voyage-4-large',
        embedding_dimensions: 2048,
        env: { VOYAGE_API_KEY: 'voyage-fake' },
      });

      const vectors = await embed(['dimension probe']);

      expect(vectors[0].length).toBe(2048);
      expect(requestBody?.output_dimension).toBe(2048);
      expect(requestBody?.encoding_format).toBe('base64');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Voyage OOM-cap rethrow regression (Codex P3 follow-up after PR #962).
// Pins the contract that VoyageResponseTooLargeError thrown from the
// inbound rewriter is NOT swallowed by the surrounding try/catch.
// ─────────────────────────────────────────────────────────────────────
describe('Voyage OOM-cap: too-large response throws (Codex P3 follow-up)', () => {
  beforeEach(() => resetGateway());

  test('Layer 1 — Content-Length above cap propagates as VoyageResponseTooLargeError', async () => {
    const originalFetch = globalThis.fetch;
    // 257 MB > 256 MB cap.
    const oversized = String(257 * 1024 * 1024);
    globalThis.fetch = (async () => {
      return new Response('{"data": []}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': oversized,
        },
      });
    }) as unknown as typeof fetch;
    try {
      configureGateway({
        embedding_model: 'voyage:voyage-4-large',
        embedding_dimensions: 1024,
        env: { VOYAGE_API_KEY: 'voyage-fake' },
      });
      let caught: unknown;
      try {
        await embed(['probe']);
      } catch (e) {
        caught = e;
      }
      // The OOM throw propagates. Provider plumbing may wrap it, but the
      // VoyageResponseTooLargeError class name + characteristic message
      // must survive.
      const msg = caught instanceof Error ? caught.message : String(caught);
      expect(msg).toContain('Content-Length=');
      expect(msg).toContain('exceeds');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Layer 2 — oversized base64 embedding string propagates (not swallowed)', async () => {
    const originalFetch = globalThis.fetch;
    // Build a JSON response with an `embedding` base64 string that decodes
    // to > 256 MB. base64 ratio is ~0.75; 360 MB of base64 chars ≈ 270 MB
    // decoded.
    const oversizedBase64 = 'A'.repeat(360 * 1024 * 1024);
    const respBody = `{"object":"list","data":[{"object":"embedding","index":0,"embedding":"${oversizedBase64}"}],"model":"voyage-4-large","usage":{"total_tokens":1}}`;
    globalThis.fetch = (async () => {
      // No Content-Length header → Layer 1 skipped, Layer 2 must fire.
      return new Response(respBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      configureGateway({
        embedding_model: 'voyage:voyage-4-large',
        embedding_dimensions: 1024,
        env: { VOYAGE_API_KEY: 'voyage-fake' },
      });
      let caught: unknown;
      try {
        await embed(['probe']);
      } catch (e) {
        caught = e;
      }
      const msg = caught instanceof Error ? caught.message : String(caught);
      // The Layer 2 throw fired and was not swallowed by the inbound
      // try/catch (pre-fix bug: bare `catch {}` returned the original
      // response and let the AI SDK OOM trying to parse it).
      expect(msg).toContain('Voyage embedding base64 exceeds');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 15000);

  test('VoyageResponseTooLargeError is exported as a tagged class', () => {
    expect(VoyageResponseTooLargeError).toBeDefined();
    const err = new VoyageResponseTooLargeError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VoyageResponseTooLargeError);
    expect(err.name).toBe('VoyageResponseTooLargeError');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Voyage flexible-dim runtime validation (Codex P3 follow-up after PR #962).
// The bug class: brain configured for Voyage flexible-dim model without
// `embedding_dimensions` → gateway falls back to DEFAULT 1536 → Voyage
// HTTP 400. Catch it at the embed-call boundary with a clear AIConfigError.
// ─────────────────────────────────────────────────────────────────────
describe('Voyage flexible-dim runtime validation', () => {
  test('rejects 1536 (the default that bites Voyage-first users) with AIConfigError', () => {
    expect(() => dimsProviderOptions('openai-compatible', 'voyage-4-large', 1536))
      .toThrow(AIConfigError);
    expect(() => dimsProviderOptions('openai-compatible', 'voyage-4-large', 1536))
      .toThrow(/embedding_dimensions|256.*512.*1024.*2048/);
  });

  test('rejects 3072 with AIConfigError', () => {
    expect(() => dimsProviderOptions('openai-compatible', 'voyage-3-large', 3072))
      .toThrow(AIConfigError);
  });

  test('accepts every Voyage-allowed flexible dim', () => {
    for (const dim of VOYAGE_VALID_OUTPUT_DIMS) {
      const opts = dimsProviderOptions('openai-compatible', 'voyage-4-large', dim);
      expect(opts).toEqual({ openaiCompatible: { dimensions: dim } });
    }
  });

  test('VOYAGE_VALID_OUTPUT_DIMS pins exactly the four Voyage values', () => {
    expect([...VOYAGE_VALID_OUTPUT_DIMS]).toEqual([256, 512, 1024, 2048]);
  });

  test('isValidVoyageOutputDim returns true only for the four valid sizes', () => {
    expect(isValidVoyageOutputDim(256)).toBe(true);
    expect(isValidVoyageOutputDim(512)).toBe(true);
    expect(isValidVoyageOutputDim(1024)).toBe(true);
    expect(isValidVoyageOutputDim(2048)).toBe(true);
    expect(isValidVoyageOutputDim(1536)).toBe(false);
    expect(isValidVoyageOutputDim(3072)).toBe(false);
    expect(isValidVoyageOutputDim(0)).toBe(false);
    expect(isValidVoyageOutputDim(-1)).toBe(false);
  });

  test('voyage-3-lite (non-flexible-dim) bypasses the validator — still returns undefined', () => {
    // Sanity: the validator only fires inside the flexible-dim branch, so
    // a fixed-dim Voyage model with any dim value goes straight through to
    // the `undefined` return path (no error, no providerOptions).
    expect(dimsProviderOptions('openai-compatible', 'voyage-3-lite', 1536)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'voyage-4-nano', 1536)).toBeUndefined();
  });

  test('AIConfigError fix hint names the canonical recovery commands', () => {
    let caught: AIConfigError | undefined;
    try {
      dimsProviderOptions('openai-compatible', 'voyage-4-large', 1536);
    } catch (e) {
      caught = e as AIConfigError;
    }
    expect(caught).toBeInstanceOf(AIConfigError);
    expect(caught?.fix).toContain('embedding_dimensions');
    expect(caught?.fix).toContain('256');
    expect(caught?.fix).toContain('2048');
  });
});
