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
const WORTH_PROCESSING_JSON = JSON.stringify({
  worth_processing: true,
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
    await withEnv({ DEEPSEEK_API_KEY: undefined }, async () => {
      const judge = makeJudgeClient('deepseek:deepseek-chat');
      expect(judge).not.toBeNull();
      expect(typeof judge?.create).toBe('function');
    });
  });
});

describe('JudgeClient.create — gateway routing + shape adapter', () => {
  test('A3: routes through gateway.chat (verified via __setChatTransportForTests stub)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-A3' }, async () => {
      const judge = makeJudgeClient('claude-haiku-4-5-20251001');
      expect(judge).not.toBeNull();

      let transportCalled = false;
      let receivedSystem: string | undefined;
      let receivedModel: string | undefined;
      __setChatTransportForTests(async (opts): Promise<ChatResult> => {
        transportCalled = true;
        receivedSystem = opts.system;
        receivedModel = opts.model;
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
      // Anthropic.Message shape returned
      expect(result.content?.[0]?.type).toBe('text');
      expect((result.content?.[0] as { type: string; text: string }).text).toBe(WORTH_PROCESSING_JSON);
    });
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
