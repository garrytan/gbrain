import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureGateway,
  resetGateway,
  __unconfigureGatewayForTests,
  isAvailable,
  embed,
  embedOne,
  embedQueryMultimodal,
  __setEmbedTransportForTests,
  getEmbeddingModel,
  getEmbeddingDimensions,
  getExpansionModel,
  VoyageResponseTooLargeError,
} from '../../src/core/ai/gateway.ts';
import { OutboundGateError, assertOutboundChatAllowed, assertOutboundImageEmbeddingAllowed, scanOutboundText } from '../../src/core/ai/outbound-gate.ts';
import { withEnv } from '../helpers/with-env.ts';

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

async function runGatewayChild(
  source: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, '-e', source], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('outbound embedding gate', () => {
  beforeEach(() => {
    resetGateway();
    __setEmbedTransportForTests(null);
  });

  test('blocks five built-in credential rule groups before any provider call', async () => {
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 3,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake-google' },
    });
    let calls = 0;
    __setEmbedTransportForTests(async () => {
      calls++;
      return { embeddings: [new Array(3).fill(0.1)], usage: { tokens: 1 } } as any;
    });
    const cases = [
      ['credential-prefix', 'prefix sk-ant-abcdefghijklmnopqrstuv'],
      ['authorization-header', 'Authorization: Bearer fake-value'],
      ['url-userinfo', 'https://fake-user:fake-password@example.test/path'],
      ['private-key-pem', '-----BEGIN PRIVATE KEY-----'],
    ] as const;

    for (const [ruleId, text] of cases) {
      let caught: unknown;
      try {
        await embed([text]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OutboundGateError);
      expect((caught as OutboundGateError).ruleId).toBe(ruleId);
    }
    expect(calls).toBe(0);
  });

  test('entropy rule is opt-in: off by default, blocks when enabled', async () => {
    const highEntropy = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
    expect(scanOutboundText(highEntropy)).toEqual({ ok: true });

    await withEnv({ GBRAIN_OUTBOUND_ENTROPY_GATE: '1' }, () => {
      const result = scanOutboundText(highEntropy);
      expect(result.ok).toBe(false);
      expect((result as { ruleId: string }).ruleId).toBe('high-entropy-token');
    });
  });

  test('placeholders in an Authorization header are not credentials', () => {
    for (const text of [
      'curl -H "Authorization: Bearer <candidate>"',
      'curl -H "Authorization: Bearer $OPENROUTER_API_KEY"',
      'Authorization: Bearer ${TOKEN}',
    ]) {
      expect(scanOutboundText(text)).toEqual({ ok: true });
    }
    for (const text of [
      'Authorization: Bearer abcdefghijklmnop',
      'Authorization: Bearer "abcdefghijklmnop"',
      "Authorization: Basic 'abcdefghijklmnop'",
    ]) {
      const real = scanOutboundText(text);
      expect(real.ok).toBe(false);
      expect((real as { ruleId: string }).ruleId).toBe('authorization-header');
    }
    expect(scanOutboundText('Authorization: Bearer "$OPENROUTER_API_KEY"')).toEqual({ ok: true });
  });

  test('a JWT-shaped token is blocked', () => {
    const result = scanOutboundText('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.sig');
    expect(result.ok).toBe(false);
    expect((result as { ruleId: string }).ruleId).toBe('jwt-token');
  });

  test('image inputs cannot reach a provider — no text rule can inspect them', () => {
    expect(() => assertOutboundImageEmbeddingAllowed(['text', 'text'])).not.toThrow();
    let caught: unknown;
    try {
      assertOutboundImageEmbeddingAllowed(['text', 'image']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OutboundGateError);
    expect((caught as OutboundGateError).ruleId).toBe('image-input-not-scannable');
    expect((caught as OutboundGateError).textIndex).toBe(1);
  });

  test('GATE_REQUIRED mode cannot be switched off', async () => {
    await withEnv(
      {
        GBRAIN_OUTBOUND_GATE_REQUIRED: '1',
        GBRAIN_OUTBOUND_ALLOW_IMAGE: '1',
      },
      () => {
        // The image escape hatch is exactly what an operator reaches for when a
        // backfill stalls; under REQUIRED it must not be reachable.
        let caught: unknown;
        try {
          assertOutboundImageEmbeddingAllowed(['image']);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(OutboundGateError);
      },
    );
  });

  test('the chat surface is closed under GATE_REQUIRED', async () => {
    // Outside the ingest child the chat surface stays open — this guard is
    // about the process that holds an embedding key, not about gbrain at large.
    await withEnv({ GBRAIN_OUTBOUND_GATE_REQUIRED: undefined }, () => {
      expect(() => assertOutboundChatAllowed('generateText')).not.toThrow();
    });

    await withEnv({ GBRAIN_OUTBOUND_GATE_REQUIRED: '1' }, () => {
      let caught: unknown;
      try {
        assertOutboundChatAllowed('generateText');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OutboundGateError);
      expect((caught as OutboundGateError).ruleId).toBe('chat-surface-closed:generateText');
    });
  });

  test('the block message does not name the disable switch', () => {
    const error = new OutboundGateError('authorization-header', 0, 0);
    expect(error.message).not.toContain('GBRAIN_OUTBOUND_GATE');
  });

  test('ordinary vault prose is not blocked', () => {
    for (const text of [
      'task-goal-oriented-planning 문서',
      'NEXT-SESSION-2026-08-10-decision-journal-capture-closed',
      'risk-user-story-mapping-and-desk-research',
      'xoxb-workspace-token 이라는 플레이스홀더',
      'sk-or-v1-... 형식으로 넣으세요',
    ]) {
      expect(scanOutboundText(text)).toEqual({ ok: true });
    }
  });

  test('blocks a process-start denylist value with zero provider calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-outbound-gate-'));
    const denylistPath = join(dir, 'denylist.txt');
    writeFileSync(denylistPath, 'fake denylisted phrase\n');
    const source = `
      const g = await import('./src/core/ai/gateway.ts');
      g.configureGateway({ embedding_model: 'google:gemini-embedding-001', embedding_dimensions: 3, env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' } });
      let calls = 0;
      g.__setEmbedTransportForTests(async () => { calls++; return { embeddings: [[0.1, 0.1, 0.1]], usage: { tokens: 1 } }; });
      try { await g.embed(['prefix fake denylisted phrase suffix']); }
      catch (error) { process.stdout.write(JSON.stringify({ name: error.name, ruleId: error.ruleId, calls })); }
    `;
    try {
      const result = await runGatewayChild(source, {
        GBRAIN_OUTBOUND_GATE: '1',
        GBRAIN_OUTBOUND_DENYLIST_FILE: denylistPath,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        name: 'OutboundGateError',
        ruleId: 'known-value-denylist',
        calls: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('allows normal text and preserves embedding behavior', async () => {
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 3,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake-google' },
    });
    let calls = 0;
    __setEmbedTransportForTests(async () => {
      calls++;
      return { embeddings: [[0.1, 0.2, 0.3]], usage: { tokens: 1 } } as any;
    });
    const vectors = await embed(['ordinary knowledge-base text']);
    expect(calls).toBe(1);
    expect(vectors[0][0]).toBeCloseTo(0.1);
    expect(vectors[0][1]).toBeCloseTo(0.2);
    expect(vectors[0][2]).toBeCloseTo(0.3);
  });

  test('one contaminated array item blocks the whole batch without partial send', async () => {
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 3,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake-google' },
    });
    let calls = 0;
    __setEmbedTransportForTests(async () => {
      calls++;
      return { embeddings: [], usage: { tokens: 1 } } as any;
    });
    await expect(embed(['clean first', 'Authorization: Basic fake-value', 'clean last']))
      .rejects.toBeInstanceOf(OutboundGateError);
    expect(calls).toBe(0);
  });

  test('GBRAIN_OUTBOUND_GATE=0 passes and warns only once', async () => {
    const source = `
      const g = await import('./src/core/ai/gateway.ts');
      g.configureGateway({ embedding_model: 'google:gemini-embedding-001', embedding_dimensions: 3, env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' } });
      let calls = 0;
      g.__setEmbedTransportForTests(async ({ values }) => { calls++; return { embeddings: values.map(() => [0.1, 0.1, 0.1]), usage: { tokens: 1 } }; });
      await g.embed(['Authorization: Bearer fake-one']);
      await g.embed(['Authorization: Bearer fake-two']);
      process.stdout.write(JSON.stringify({ calls }));
    `;
    const result = await runGatewayChild(source, { GBRAIN_OUTBOUND_GATE: '0' });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ calls: 2 });
    expect(result.stderr.match(/outbound embedding gate disabled/g)?.length).toBe(1);
  });

  test('missing denylist file disables only that source', async () => {
    const source = `
      const g = await import('./src/core/ai/gateway.ts');
      g.configureGateway({ embedding_model: 'google:gemini-embedding-001', embedding_dimensions: 3, env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' } });
      let calls = 0;
      g.__setEmbedTransportForTests(async () => { calls++; return { embeddings: [[0.1, 0.1, 0.1]], usage: { tokens: 1 } }; });
      let ruleId = null;
      try { await g.embed(['Authorization: Bearer fake-value']); } catch (error) { ruleId = error.ruleId; }
      process.stdout.write(JSON.stringify({ calls, ruleId }));
    `;
    const result = await runGatewayChild(source, {
      GBRAIN_OUTBOUND_GATE: '1',
      GBRAIN_OUTBOUND_DENYLIST_FILE: join(tmpdir(), 'does-not-exist-gbrain-denylist'),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ calls: 0, ruleId: 'authorization-header' });
  });

  test('error object and message never contain the matched credential', async () => {
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 3,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake-google' },
    });
    const credential = 'sk-ant-this-is-a-fake-credential-value';
    let caught: OutboundGateError | undefined;
    try {
      await embed([`prefix ${credential} suffix`]);
    } catch (error) {
      caught = error as OutboundGateError;
    }
    const serialized = [
      caught?.name,
      caught?.message,
      caught?.stack,
      JSON.stringify(caught),
      ...Object.values(caught ?? {}).map(String),
    ].join('\n');
    expect(serialized.includes(credential)).toBe(false);
  });

  test('embedOne and embedQuery both pass through the gate', async () => {
    const { embedQuery } = await import('../../src/core/ai/gateway.ts');
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 3,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake-google' },
    });
    let calls = 0;
    __setEmbedTransportForTests(async () => {
      calls++;
      return { embeddings: [[0.1, 0.1, 0.1]], usage: { tokens: 1 } } as any;
    });
    await expect(embedOne('Authorization: Bearer fake-one')).rejects.toBeInstanceOf(OutboundGateError);
    await expect(embedQuery('https://fake:fake@example.test')).rejects.toBeInstanceOf(OutboundGateError);
    expect(calls).toBe(0);
  });

  test('multimodal text queries are blocked before direct fetch', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error('fetch must not run');
    }) as unknown as typeof fetch;
    try {
      await expect(embedQueryMultimodal('Authorization: Bearer fake-value'))
        .rejects.toBeInstanceOf(OutboundGateError);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

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

  test('defaults are ZE 1280d as of v0.36.0.0 (D3)', () => {
    // The default flipped from openai:text-embedding-3-large 1536d to
    // zeroentropyai:zembed-1 1280d in v0.36.0.0. The cost story is in
    // CHANGELOG.md; the rationale lives in src/core/ai/gateway.ts:45-54.
    configureGateway({ env: {} });
    expect(getEmbeddingModel()).toBe('zeroentropyai:zembed-1');
    expect(getEmbeddingDimensions()).toBe(1280);
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
    const opts = dimsProviderOptions('native-google', 'gemini-embedding-001', 1024);
    expect(opts).toEqual({ google: { outputDimensionality: 1024 } });
  });

  test('OpenRouter Gemini embedding returns dimensions for a reduced width', () => {
    const opts = dimsProviderOptions('openai-compatible', 'google/gemini-embedding-001', 1024);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('OpenRouter Gemini embedding omits dimensions at the native width', () => {
    const opts = dimsProviderOptions('openai-compatible', 'google/gemini-embedding-001', 3072);
    expect(opts).toBeUndefined();
  });

  test('OpenRouter Gemini embedding rejects dimensions outside 1..3072', () => {
    expect(() => dimsProviderOptions('openai-compatible', 'google/gemini-embedding-001', 3073))
      .toThrow(AIConfigError);
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
