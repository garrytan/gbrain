import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __unconfigureGatewayForTests,
  isAvailable,
  embed,
  embedOne,
  __setEmbedTransportForTests,
  getEmbeddingModel,
  getEmbeddingDimensions,
  getExpansionModel,
  VoyageResponseTooLargeError,
} from '../../src/core/ai/gateway.ts';

// v0.39.x ship-wave fix: gateway module is process-scoped. Without an
// afterAll cleanup, the last test's configureGateway({env: {OPENAI_API_KEY:
// 'openai-fake'}}) state leaked into sibling files in the same bun shard
// (capture / ingest-capture tests), where it produced "Incorrect API key
// provided: openai-fake" against the real OpenAI endpoint and wedged
// the shard. Reset once at file teardown so no caller sees the residue.
afterAll(() => {
  resetGateway();
  __setEmbedTransportForTests(null);
});
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

  test('defaults are Voyage 1024d as of v0.36.0.0 (D3)', () => {
    // The default flipped from openai:text-embedding-3-large 1536d to
    // voyage:voyage-4 1024d in v0.36.0.0. The cost story is in
    // CHANGELOG.md; the rationale lives in src/core/ai/gateway.ts:45-54.
    configureGateway({ env: {} });
    expect(getEmbeddingModel()).toBe('voyage:voyage-4');
    expect(getEmbeddingDimensions()).toBe(1024);
    expect(getExpansionModel()).toBe('anthropic:claude-haiku-4-5-20251001');
  });
});

describe('gateway.embedOne options', () => {
  beforeEach(() => {
    resetGateway();
    __setEmbedTransportForTests(null);
  });

  test('passes maxRetries=0 to the provider transport for health probes', async () => {
    let observedMaxRetries: number | undefined;
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 3,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake-google' },
    });
    __setEmbedTransportForTests(async (args: any) => {
      observedMaxRetries = args.maxRetries;
      return {
        embeddings: [new Array(3).fill(0.1)],
        usage: { tokens: 1 },
      } as any;
    });

    const vector = await embedOne('health probe', { maxRetries: 0 });

    expect(observedMaxRetries).toBe(0);
    expect(vector.length).toBe(3);
    __setEmbedTransportForTests(null);
  });
});

describe('gateway.isAvailable (silent-drop regression surface)', () => {
  beforeEach(() => resetGateway());

  test('returns false when gateway not configured', () => {
    // resetGateway() restores the preload's test baseline (#3554); go
    // genuinely unconfigured for this one assertion.
    __unconfigureGatewayForTests();
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

  // #1135 — an explicit expansion_model pointed at a chat-capable
  // OpenAI-compatible provider used to silently yield no expansion because
  // the recipe declared no expansion touchpoint.
  test('expansion available for chat-capable openai-compat providers (deepseek/groq/together/openrouter)', () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['deepseek:deepseek-chat', { DEEPSEEK_API_KEY: 'fake' }],
      ['groq:llama-3.1-8b-instant', { GROQ_API_KEY: 'fake' }],
      ['together:meta-llama/Llama-3.3-70B-Instruct-Turbo', { TOGETHER_API_KEY: 'fake' }],
      ['openrouter:google/gemini-3-flash-preview', { OPENROUTER_API_KEY: 'fake' }],
    ];
    for (const [model, env] of cases) {
      resetGateway();
      configureGateway({ expansion_model: model, env });
      expect(isAvailable('expansion'), `${model} expansion should be available`).toBe(true);
    }
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

  test('OpenAI-compatible gemini-embedding returns dimensions', () => {
    const opts = dimsProviderOptions('openai-compatible', 'google/gemini-embedding-001', 1024);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('OpenAI-compatible text-embedding-004 (legacy Gemini id via a router) returns dimensions', () => {
    // Routers serve the 768-native legacy id alongside gemini-embedding-*;
    // without the branch a narrower brain gets the native width and fails on
    // its first embed with a dim mismatch.
    const opts = dimsProviderOptions('openai-compatible', 'text-embedding-004', 768);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 768 } });
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

describe('embedding response integrity', () => {
  beforeEach(() => resetGateway());

  test('rejects partial embedding responses instead of silently dropping rows', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      object: 'list',
      data: [
        {
          object: 'embedding',
          index: 0,
          embedding: new Array(1536).fill(0.01),
        },
      ],
      model: 'text-embedding-3-large',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    try {
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: 1536,
        env: { OPENAI_API_KEY: 'openai-fake' },
      });

      await expect(embed(['first', 'second'])).rejects.toThrow('1 embedding(s) for 2 input(s)');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('checks every returned vector dimension, not just the first one', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      object: 'list',
      data: [
        {
          object: 'embedding',
          index: 0,
          embedding: new Array(1536).fill(0.01),
        },
        {
          object: 'embedding',
          index: 1,
          embedding: new Array(768).fill(0.01),
        },
      ],
      model: 'text-embedding-3-large',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    try {
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: 1536,
        env: { OPENAI_API_KEY: 'openai-fake' },
      });

      await expect(embed(['first', 'second'])).rejects.toThrow('returned 768 but schema expects 1536');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('nvidia Nemotron embedding compatibility', () => {
  const modelId = 'nvidia/Nemotron-3-Embed-8B';

  beforeEach(() => {
    resetGateway();
    __setEmbedTransportForTests(null);
  });

  function configureNemotron(dimensions: number, selectedModelId = modelId): void {
    configureGateway({
      embedding_model: `litellm:${selectedModelId}`,
      embedding_dimensions: dimensions,
      env: { LITELLM_API_KEY: 'test-only' },
    });
  }

  function vectorWithPrefix(prefixWidth: number, first: number, second: number): number[] {
    const vector = new Array(4096).fill(0);
    vector[0] = first;
    vector[1] = second;
    // This value is outside the requested prefix. Normalizing the full vector
    // instead of the retained prefix would produce a different first value.
    vector[prefixWidth] = 12;
    return vector;
  }

  function setEmbeddingResponses(
    embeddings: number[][] | ((inputs: string[]) => number[][]),
  ): void {
    __setEmbedTransportForTests(async (args: any) => ({
      embeddings: typeof embeddings === 'function' ? embeddings(args.values) : embeddings,
      usage: { tokens: args.values.length },
    }) as any);
  }

  test('normalizes the first 1024 coordinates by the prefix norm', async () => {
    configureNemotron(1024);
    setEmbeddingResponses([vectorWithPrefix(1024, 3, 4)]);

    const [vector] = await embed(['one passage']);

    expect(vector).toHaveLength(1024);
    expect(vector[0]).toBeCloseTo(0.6, 6);
    expect(vector[1]).toBeCloseTo(0.8, 6);
    expect(vector[2]).toBe(0);
  });

  test('normalizes the first 2048 coordinates by the prefix norm', async () => {
    configureNemotron(2048);
    setEmbeddingResponses([vectorWithPrefix(2048, 3, 4)]);

    const [vector] = await embed(['one passage']);

    expect(vector).toHaveLength(2048);
    expect(vector[0]).toBeCloseTo(0.6, 6);
    expect(vector[1]).toBeCloseTo(0.8, 6);
    expect(vector[2]).toBe(0);
  });

  test('preserves batch order and cardinality while transforming each row', async () => {
    configureNemotron(1024);
    const inputs: string[] = [];
    setEmbeddingResponses((values) => {
      inputs.push(...values);
      return [vectorWithPrefix(1024, 3, 4), vectorWithPrefix(1024, 4, 3)];
    });

    const vectors = await embed(['first passage', 'second passage']);

    expect(inputs).toEqual(['first passage', 'second passage']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(1024);
    expect(vectors[1]).toHaveLength(1024);
    expect(vectors[0]![0]).toBeCloseTo(0.6, 6);
    expect(vectors[0]![1]).toBeCloseTo(0.8, 6);
    expect(vectors[1]![0]).toBeCloseTo(0.8, 6);
    expect(vectors[1]![1]).toBeCloseTo(0.6, 6);
  });

  test('leaves an already expected-width vector unchanged', async () => {
    configureNemotron(1024);
    const expectedWidth = new Array(1024).fill(0);
    expectedWidth[0] = 3;
    expectedWidth[1] = 4;
    setEmbeddingResponses([expectedWidth]);

    const [vector] = await embed(['already narrow']);

    expect(vector).toHaveLength(1024);
    expect(vector[0]).toBe(3);
    expect(vector[1]).toBe(4);
  });

  test('rejects non-finite prefix coordinates and non-finite or zero norms', async () => {
    configureNemotron(1024);
    const malformed: Array<[string, number[]]> = [
      ['NaN coordinate', [Number.NaN, 1]],
      ['infinite coordinate', [Number.POSITIVE_INFINITY, 1]],
      ['non-finite norm', [Number.MAX_VALUE, Number.MAX_VALUE]],
      ['zero norm', [0, 0]],
    ];

    for (const [label, firstTwo] of malformed) {
      const vector = new Array(4096).fill(0);
      vector[0] = firstTwo[0];
      vector[1] = firstTwo[1];
      setEmbeddingResponses([vector]);
      await expect(embed([label])).rejects.toThrow(/finite|norm|zero/i);
    }
  });

  test('rejects a wrong raw response width', async () => {
    configureNemotron(1024);
    setEmbeddingResponses([new Array(3072).fill(1)]);

    await expect(embed(['wrong raw width'])).rejects.toThrow('returned 3072 but schema expects 1024');
  });

  test('rejects an unsupported target width for a 4096-coordinate response', async () => {
    configureNemotron(1536);
    setEmbeddingResponses([new Array(4096).fill(1)]);

    await expect(embed(['unsupported target'])).rejects.toThrow('returned 4096 but schema expects 1536');
  });

  test('does not transform a different model id', async () => {
    configureNemotron(1024, 'nvidia/Nemotron-3-Embed-8b');
    setEmbeddingResponses([new Array(4096).fill(1)]);

    await expect(embed(['different model id'])).rejects.toThrow('returned 4096 but schema expects 1024');
  });
});
