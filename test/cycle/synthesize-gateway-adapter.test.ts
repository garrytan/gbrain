/**
 * Gateway-adapter tests for the dream-cycle significance judge (T5 + T6 wave).
 *
 * Replaces the v0.23-era `new Anthropic()` direct-SDK construction with a
 * gateway-routed JudgeClient that works for any provider with a registered
 * recipe (Anthropic, DeepSeek, OpenRouter, Voyage, Ollama, llama-server, ...).
 *
 * Mirrors the test pattern from test/think-gateway-adapter.test.ts for parity
 * with src/core/think/index.ts (v0.35.5.0). The IRON RULE regression R3 lives
 * here too — given identical canned LLM text, judgeSignificance produces the
 * same {worth_processing, reasons} via the gateway-adapter shape as it would
 * via the legacy Anthropic SDK shape. The contract that matters is parsed-
 * verdict SEMANTIC PARITY (not byte-identical Anthropic.Message struct, which
 * codex correctly flagged as a meaningless gate).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { makeJudgeClient, judgeSignificance, type JudgeClient } from '../../src/core/cycle/synthesize.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { DiscoveredTranscript } from '../../src/core/cycle/transcript-discovery.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

// Canned "worth processing" LLM text used by the parsed-verdict parity tests.
// Mirrors what a well-tuned Haiku would emit for a substantive transcript.
// Triage-v1 (#4152): the judge emits a scored verdict; worth_processing is
// derived from `score >= DEFAULT_TRIAGE_THRESHOLD`.
const WORTH_PROCESSING_JSON = JSON.stringify({
  score: 0.85,
  content_type: 'strategy',
  segments: [],
  entities: [],
  reasons: ['user reflects on portfolio framework', 'concrete strategic call'],
});

// Synthetic transcript fixture for judgeSignificance — only `content` and
// `basename` are read by the judge.
const FIXTURE_TRANSCRIPT: DiscoveredTranscript = {
  filePath: '/dev/null/fixture.txt',
  basename: 'fixture',
  content: 'Synthetic transcript content for gateway-adapter parity tests.',
  contentHash: 'sha-fixture-1',
  inferredDate: '2026-05-24',
};

describe('makeJudgeClient — construction-time provider probe', () => {
  test('A1: returns null when verdict model is anthropic and no API key is configured', async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      // Use a synthetic config path to avoid surfacing a stored anthropic_api_key.
      await withEnv({ GBRAIN_HOME: '/tmp/nonexistent-gbrain-home-for-A1' }, async () => {
        const judge = makeJudgeClient('claude-haiku-4-5-20251001');
        expect(judge).toBeNull();
      });
    });
  });

  test('A2: returns a JudgeClient when chat provider is reachable (anthropic key set)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-A2' }, async () => {
      const judge = makeJudgeClient('claude-haiku-4-5-20251001');
      expect(judge).not.toBeNull();
      expect(typeof judge?.create).toBe('function');
    });
  });

  test('A8: returns null when verdict model has unknown provider prefix', async () => {
    // resolveRecipe throws AIConfigError on unknown provider id;
    // makeJudgeClient catches it and returns null.
    const judge = makeJudgeClient('notarealprovider:some-model');
    expect(judge).toBeNull();
  });

  test('A9: returns a JudgeClient for non-anthropic providers without probing env (delegates to gateway)', async () => {
    // Non-anthropic providers don't get the hasAnthropicKey() short-circuit.
    // The deepseek recipe declares DEEPSEEK_API_KEY in auth_env.required;
    // makeJudgeClient delegates that probe to gateway.chat at call time
    // (where it would throw AIConfigError, caught per-transcript by the loop).
    // #1698 C1: this MUST stay green — validateModelId (id-validity only) does NOT
    // reject a non-anthropic provider for a missing key (no isAvailable here).
    await withEnv({ DEEPSEEK_API_KEY: undefined }, async () => {
      const judge = makeJudgeClient('deepseek:deepseek-chat');
      expect(judge).not.toBeNull();
      expect(typeof judge?.create).toBe('function');
    });
  });

  test('A8b (#1698): chat-less-provider model → null at construction (validateModelId unknown_model)', async () => {
    // validateModelId rejects a provider with no chat touchpoint (voyage).
    // Unlisted ids on chat-capable providers pass local validation now (no
    // runtime allowlist) and fail at the provider instead.
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-A8b' }, async () => {
      const judge = makeJudgeClient('voyage:voyage-3');
      expect(judge).toBeNull();
    });
  });
});

describe('JudgeClient.create — gateway routing + shape adapter', () => {
  test('A2b (#4077): forwards a caller AbortSignal to gateway.chat', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-A2b' }, async () => {
      const judge = makeJudgeClient('claude-haiku-4-5-20251001');
      expect(judge).not.toBeNull();
      const abort = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      __setChatTransportForTests(async (opts): Promise<ChatResult> => {
        receivedSignal = opts.abortSignal;
        return {
          text: WORTH_PROCESSING_JSON,
          blocks: [],
          stopReason: 'end',
          usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'test:stub',
          providerId: 'test',
        };
      });

      await judge!.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: 'judge system prompt',
        messages: [{ role: 'user', content: 'judge this' }],
      }, { signal: abort.signal });

      // The exact caller signal must reach the transport — a cancelled cycle
      // has to be able to tear down an in-flight judge call, not just skip
      // the next one.
      expect(receivedSignal).toBe(abort.signal);
    });
  });

  test('A3: routes through gateway.chat (verified via __setChatTransportForTests stub)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-A3' }, async () => {
      const judge = makeJudgeClient('claude-haiku-4-5-20251001');
      expect(judge).not.toBeNull();

      let transportCalled = false;
      let receivedSystem: string | undefined;
      let receivedModel: string | undefined;
      let receivedProviderOptions: Record<string, Record<string, unknown>> | undefined;
      __setChatTransportForTests(async (opts): Promise<ChatResult> => {
        transportCalled = true;
        receivedSystem = opts.system;
        receivedModel = opts.model;
        receivedProviderOptions = opts.providerOptions;
        return {
          text: WORTH_PROCESSING_JSON,
          blocks: [],
          stopReason: 'end',
          usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'test:stub',
          providerId: 'test',
        };
      });

      const result = await judge!.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: 'judge system prompt',
        messages: [{ role: 'user', content: 'judge this' }],
      });

      expect(transportCalled).toBe(true);
      expect(receivedSystem).toBe('judge system prompt');
      // Gateway model gets the anthropic: prefix normalized
      expect(receivedModel).toBe('anthropic:claude-haiku-4-5-20251001');
      // The thinking-disable pin is DeepSeek-only; other providers must not
      // receive call-scoped provider options from the judge.
      expect(receivedProviderOptions).toBeUndefined();
      // Anthropic.Message shape returned
      expect(result.content?.[0]?.type).toBe('text');
      expect((result.content?.[0] as { type: string; text: string }).text).toBe(WORTH_PROCESSING_JSON);
    });
  });

  test('A3b: DeepSeek verdict judge disables thinking for its own call only', async () => {
    // DeepSeek v4 models think by default and bill reasoning as OUTPUT tokens
    // against max_tokens (recipe thinking_by_default, gbrain#4172). The triage
    // judge wants the plain JSON verdict, so it pins thinking off per-call via
    // ChatOpts.providerOptions instead of burning budget on reasoning.
    // No DEEPSEEK_API_KEY needed: non-anthropic construction skips the key
    // probe (A9) and the transport is stubbed.
    const judge = makeJudgeClient('deepseek:deepseek-v4-flash');
    expect(judge).not.toBeNull();

    let receivedProviderOptions: Record<string, Record<string, unknown>> | undefined;
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      receivedProviderOptions = opts.providerOptions;
      return {
        text: WORTH_PROCESSING_JSON,
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'deepseek:deepseek-v4-flash',
        providerId: 'deepseek',
      };
    });

    await judge!.create({
      model: 'deepseek:deepseek-v4-flash',
      max_tokens: 1024,
      system: 'judge system prompt',
      messages: [{ role: 'user', content: 'judge this' }],
    });

    expect(receivedProviderOptions).toEqual({
      deepseek: { thinking: { type: 'disabled' } },
    });
  });

  test('A3c: OpenRouter DeepSeek verdict judge disables thinking for its own call only', async () => {
    // Same contract as A3b for the OpenRouter-hosted DeepSeek routes (#4758):
    // the recipe declares thinking_by_default for `deepseek/…`, so the judge
    // pins thinking off per-call under the openrouter providerOptions
    // namespace (the openai-compatible adapter spreads
    // providerOptions[recipe.id] into the wire body).
    const judge = makeJudgeClient('openrouter:deepseek/deepseek-v4-flash-0731');
    expect(judge).not.toBeNull();

    let receivedProviderOptions: Record<string, Record<string, unknown>> | undefined;
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      receivedProviderOptions = opts.providerOptions;
      return {
        text: WORTH_PROCESSING_JSON,
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'openrouter:deepseek/deepseek-v4-flash-0731',
        providerId: 'openrouter',
      };
    });

    await judge!.create({
      model: 'openrouter:deepseek/deepseek-v4-flash-0731',
      max_tokens: 1024,
      system: 'judge system prompt',
      messages: [{ role: 'user', content: 'judge this' }],
    });

    expect(receivedProviderOptions).toEqual({
      openrouter: { thinking: { type: 'disabled' } },
    });
  });

  test('A3d: OpenRouter non-DeepSeek routes receive no thinking pin', async () => {
    // The pin is family-scoped: an anthropic/ route via OR must not get a
    // DeepSeek-shaped `thinking` knob sprayed into its wire body.
    const judge = makeJudgeClient('openrouter:anthropic/claude-haiku-4.5');
    expect(judge).not.toBeNull();

    let receivedProviderOptions: Record<string, Record<string, unknown>> | undefined;
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      receivedProviderOptions = opts.providerOptions;
      return {
        text: WORTH_PROCESSING_JSON,
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'openrouter:anthropic/claude-haiku-4.5',
        providerId: 'openrouter',
      };
    });

    await judge!.create({
      model: 'openrouter:anthropic/claude-haiku-4.5',
      max_tokens: 1024,
      system: 'judge system prompt',
      messages: [{ role: 'user', content: 'judge this' }],
    });

    expect(receivedProviderOptions).toBeUndefined();
  });

  test('A4: ChatResult.text → Anthropic.Message.content[0].text mapping', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-A4' }, async () => {
      const judge = makeJudgeClient('claude-haiku-4-5-20251001');
      __setChatTransportForTests(async (): Promise<ChatResult> => ({
        text: 'mapped text content',
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
          providerId: 'test',
      }));

      const result = await judge!.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
      });

      expect(result.role).toBe('assistant');
      expect(result.type).toBe('message');
      expect(result.content?.[0]?.type).toBe('text');
      expect((result.content?.[0] as { type: string; text: string }).text).toBe('mapped text content');
      expect(result.usage.input_tokens).toBe(5);
      expect(result.usage.output_tokens).toBe(5);
    });
  });

  test('A5: empty text from gateway → returns Anthropic.Message with empty text content (graceful)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-A5' }, async () => {
      const judge = makeJudgeClient('claude-haiku-4-5-20251001');
      __setChatTransportForTests(async (): Promise<ChatResult> => ({
        text: '',
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
          providerId: 'test',
      }));

      const result = await judge!.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
      });

      // Doesn't throw; produces a well-shaped Anthropic.Message with empty text.
      expect(result.content?.[0]?.type).toBe('text');
      expect((result.content?.[0] as { type: string; text: string }).text).toBe('');
    });
  });

  test('A6: non-AIConfigError from gateway propagates to caller (no swallowing)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-A6' }, async () => {
      const judge = makeJudgeClient('claude-haiku-4-5-20251001');
      __setChatTransportForTests(async (): Promise<ChatResult> => {
        throw new Error('network blip');
      });

      let caught: unknown = null;
      try {
        await judge!.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 100,
          system: 's',
          messages: [{ role: 'user', content: 'u' }],
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('network blip');
    });
  });

  test('A7: AIConfigError from gateway propagates as AIConfigError (caught by verdict loop in production)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-A7' }, async () => {
      const judge = makeJudgeClient('claude-haiku-4-5-20251001');
      __setChatTransportForTests(async (): Promise<ChatResult> => {
        throw new AIConfigError('anthropic_api_key revoked mid-run');
      });

      let caught: unknown = null;
      try {
        await judge!.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 100,
          system: 's',
          messages: [{ role: 'user', content: 'u' }],
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AIConfigError);
    });
  });

  test('A10: ChatResult.stopReason propagates — length → max_tokens, end → end_turn', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-A10' }, async () => {
      const judge = makeJudgeClient('claude-haiku-4-5-20251001');

      let nextStopReason: ChatResult['stopReason'] = 'length';
      __setChatTransportForTests(async (): Promise<ChatResult> => ({
        text: '{"worth_processing"',
        blocks: [],
        stopReason: nextStopReason,
        usage: { input_tokens: 5, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      }));

      const params = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: 's',
        messages: [{ role: 'user' as const, content: 'u' }],
      };

      // Pre-fix the adapter pinned stop_reason to 'end_turn', hiding
      // truncation from judgeSignificance. 'length' must surface as the
      // Anthropic-shape 'max_tokens'.
      const truncatedMsg = await judge!.create(params);
      expect(truncatedMsg.stop_reason).toBe('max_tokens');

      nextStopReason = 'end';
      const cleanMsg = await judge!.create(params);
      expect(cleanMsg.stop_reason).toBe('end_turn');

      // String() widening: the pinned Anthropic SDK's stop_reason union
      // predates 'refusal', but the adapter emits it for blocked responses.
      nextStopReason = 'refusal';
      const refusedMsg = await judge!.create(params);
      expect(String(refusedMsg.stop_reason)).toBe('refusal');

      nextStopReason = 'content_filter';
      const filteredMsg = await judge!.create(params);
      expect(String(filteredMsg.stop_reason)).toBe('refusal');

      // 'other' is the gateway's catch-all for unknown provider finish
      // reasons — some non-standard providers report successful stops that
      // way, so it must stay a cacheable clean stop.
      nextStopReason = 'other';
      const otherMsg = await judge!.create(params);
      expect(otherMsg.stop_reason).toBe('end_turn');
    });
  });
});

describe('R3 — parsed-verdict semantic parity (IRON RULE regression)', () => {
  /**
   * The contract that matters: given identical canned LLM text content,
   * judgeSignificance produces the same {worth_processing, reasons} parsed
   * values whether the JudgeClient is a gateway-routed adapter or a hand-
   * rolled stub matching the pre-v0.40.x Anthropic SDK shape. Byte-identity
   * of the underlying Anthropic.Message struct is NOT the contract (per
   * codex outside-voice review of the wave plan).
   */
  test('R3: gateway-routed JudgeClient produces same parsed verdict as legacy SDK-shape JudgeClient', async () => {
    // The "legacy" path — a JudgeClient that returns an Anthropic.Message
    // shape directly, bypassing the gateway. This is the shape
    // makeHaikuClient() used to construct via `new Anthropic()`.
    const legacyJudge: JudgeClient = {
      create: async () => ({
        id: 'msg_legacy',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: WORTH_PROCESSING_JSON }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    };

    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-R3' }, async () => {
      const gatewayJudge = makeJudgeClient('claude-haiku-4-5-20251001');
      expect(gatewayJudge).not.toBeNull();
      __setChatTransportForTests(async (): Promise<ChatResult> => ({
        text: WORTH_PROCESSING_JSON,
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5-20251001',
        providerId: 'anthropic',
      }));

      const [legacyVerdict, gatewayVerdict] = await Promise.all([
        judgeSignificance(legacyJudge, FIXTURE_TRANSCRIPT, 'claude-haiku-4-5-20251001'),
        judgeSignificance(gatewayJudge!, FIXTURE_TRANSCRIPT, 'claude-haiku-4-5-20251001'),
      ]);

      // The parsed-verdict semantic-parity contract.
      expect(gatewayVerdict.worth_processing).toBe(legacyVerdict.worth_processing);
      expect(gatewayVerdict.reasons).toEqual(legacyVerdict.reasons);
      // Sanity: both produced the expected verdict (not just both empty).
      expect(legacyVerdict.worth_processing).toBe(true);
      expect(legacyVerdict.reasons.length).toBeGreaterThan(0);
    });
  });

  test('R3 corollary: unparseable LLM output → both paths return cheap-fallback verdict', async () => {
    // Pre-rework AND post-rework both fall through to the
    // "judge response unparseable" branch when content isn't JSON.
    const legacyJudge: JudgeClient = {
      create: async () => ({
        id: 'msg_legacy_garbage',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'not json at all' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    };

    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-R3b' }, async () => {
      const gatewayJudge = makeJudgeClient('claude-haiku-4-5-20251001');
      __setChatTransportForTests(async (): Promise<ChatResult> => ({
        text: 'not json at all',
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5-20251001',
        providerId: 'anthropic',
      }));

      const [legacyVerdict, gatewayVerdict] = await Promise.all([
        judgeSignificance(legacyJudge, FIXTURE_TRANSCRIPT, 'claude-haiku-4-5-20251001'),
        judgeSignificance(gatewayJudge!, FIXTURE_TRANSCRIPT, 'claude-haiku-4-5-20251001'),
      ]);

      expect(legacyVerdict.worth_processing).toBe(false);
      expect(gatewayVerdict.worth_processing).toBe(false);
      expect(gatewayVerdict.reasons).toEqual(legacyVerdict.reasons);
    });
  });
});
