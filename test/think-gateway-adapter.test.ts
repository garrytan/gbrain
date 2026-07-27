/**
 * Gateway adapter tests for runThink (#952 fix).
 *
 * Pre-v0.36, runThink instantiated `new Anthropic()` directly. Closing #952
 * routed it through gateway.chat() so MCP stdio launches pick up
 * `anthropic_api_key` from gbrain config instead of process.env.
 *
 * The adapter shape was determined by plan-eng-review D10 (cross-model
 * tension D10 with codex C7+C8+C9+C10):
 *   - drop new Anthropic() entirely
 *   - real availability check (NOT a false-positive `getChatModel()` truthy)
 *   - model-id normalization (bare → provider-prefixed)
 *   - response-shape conversion (ChatResult → Anthropic.Message)
 *
 * These tests pin the four spec points. Hermetic — no real LLM call.
 */

import { describe, test, expect } from 'bun:test';
import { __thinkAdapter } from '../src/core/think/index.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

describe('think gateway adapter — response shape conversion', () => {
  test('chatResultToMessage maps ChatResult.text to Anthropic.Message content[0].text', () => {
    const out = __thinkAdapter.chatResultToMessage(
      {
        text: '{"answer":"hi","citations":[],"gaps":[]}',
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-opus-4-7',
        providerId: 'anthropic',
      },
      'anthropic:claude-opus-4-7',
    );
    expect(out.content[0].type).toBe('text');
    expect(out.content[0].text).toBe('{"answer":"hi","citations":[],"gaps":[]}');
    expect(out.usage.input_tokens).toBe(5);
    expect(out.usage.output_tokens).toBe(2);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.model).toBe('anthropic:claude-opus-4-7');
  });

  test('mapStopReason covers the full provider-neutral stop-reason set', () => {
    expect(__thinkAdapter.mapStopReason('end')).toBe('end_turn');
    expect(__thinkAdapter.mapStopReason('length')).toBe('max_tokens');
    expect(__thinkAdapter.mapStopReason('tool_calls')).toBe('tool_use');
    // 'refusal', 'content_filter', 'other' → end_turn (no Anthropic equivalent).
    expect(__thinkAdapter.mapStopReason('refusal')).toBe('end_turn');
    expect(__thinkAdapter.mapStopReason('content_filter')).toBe('end_turn');
    expect(__thinkAdapter.mapStopReason('other')).toBe('end_turn');
  });
});

describe('think gateway adapter — model-id normalization', () => {
  test('tryBuildGatewayClient accepts bare anthropic model ids and prefixes anthropic:', async () => {
    // Bare model: `claude-opus-4-7` → must resolve through `anthropic:` recipe.
    // resolveRecipe will throw AIConfigError for unknown providers, so a
    // successful build proves the prefix landed.
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-fake' }, async () => {
      const client = await __thinkAdapter.tryBuildGatewayClient('claude-opus-4-7');
      expect(client).not.toBeNull();
    });
  });

  test('tryBuildGatewayClient accepts already-prefixed provider:model strings', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-fake' }, async () => {
      const client = await __thinkAdapter.tryBuildGatewayClient('anthropic:claude-sonnet-4-6');
      expect(client).not.toBeNull();
    });
  });

  test('tryBuildGatewayClient returns null on unknown provider (AIConfigError → graceful fallback)', async () => {
    const client = await __thinkAdapter.tryBuildGatewayClient('nonexistent-provider:foo-1');
    expect(client).toBeNull();
  });

  test('tryBuildGatewayClient returns null when ANTHROPIC_API_KEY is absent (preserves legacy NO_ANTHROPIC_API_KEY signal)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const client = await __thinkAdapter.tryBuildGatewayClient('claude-opus-4-7');
      expect(client).toBeNull();
    });
  });

  test('hasAnthropicKey reads process.env', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-key' }, async () => {
      expect(__thinkAdapter.hasAnthropicKey()).toBe(true);
    });
    await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      expect(__thinkAdapter.hasAnthropicKey()).toBe(false);
    });
  });
});

describe('think gateway adapter — #1698 slash form + explicit-model fork', () => {
  test('tryBuildGatewayClient accepts SLASH form (anthropic/claude-...) — the reported bug', async () => {
    // Pre-fix the colon-only inline produced `anthropic:anthropic/claude-sonnet-4-6`
    // and the client silently degraded. normalizeModelId fixes it → builds cleanly.
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-fake' }, async () => {
      const client = await __thinkAdapter.tryBuildGatewayClient('anthropic/claude-sonnet-4-6');
      expect(client).not.toBeNull();
    });
  });

  test('explicit unresolvable model THROWS (does not degrade to null)', async () => {
    await expect(
      __thinkAdapter.tryBuildGatewayClient('bogusprovider:foo-1', { explicitModel: true }),
    ).rejects.toThrow(/not usable.*unknown_provider/);
  });

  test('explicit typo native model THROWS (unknown_model)', async () => {
    await expect(
      __thinkAdapter.tryBuildGatewayClient('anthropic:claude-bogus-9', { explicitModel: true }),
    ).rejects.toThrow(/not usable.*unknown_model/);
  });

  test('explicit anthropic model with no key THROWS (unavailable)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      await expect(
        __thinkAdapter.tryBuildGatewayClient('anthropic:claude-sonnet-4-6', { explicitModel: true }),
      ).rejects.toThrow(/not usable.*unavailable/);
    });
  });

  test('NON-explicit unresolvable model returns null (graceful, unchanged)', async () => {
    const client = await __thinkAdapter.tryBuildGatewayClient('bogusprovider:foo-1', { explicitModel: false });
    expect(client).toBeNull();
  });

  test('create-callback fork: explicit rethrows AIConfigError; non-explicit returns the sentinel', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-fake' }, async () => {
      // Build valid clients (key present → probe ok) but leave the gateway UNCONFIGURED
      // so gateway.chat() throws AIConfigError (requireConfig) at create() time.
      resetGateway();
      const params: any = {
        model: 'anthropic:claude-sonnet-4-6',
        max_tokens: 16,
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      };

      const explicitClient = await __thinkAdapter.tryBuildGatewayClient(
        'anthropic:claude-sonnet-4-6', { explicitModel: true },
      );
      expect(explicitClient).not.toBeNull();
      await expect(explicitClient!.create(params)).rejects.toThrow();

      const gracefulClient = await __thinkAdapter.tryBuildGatewayClient(
        'anthropic:claude-sonnet-4-6', { explicitModel: false },
      );
      expect(gracefulClient).not.toBeNull();
      const msg = await gracefulClient!.create(params);
      const text = msg.content.find((b: any) => b.type === 'text');
      expect(text && 'text' in text ? text.text : '').toContain('no LLM available');
    });
  });

  // D1 BACKSTOP (codex #1, accepted-as-is): probeChatModel only PRE-checks the Anthropic
  // key, so an explicit NON-anthropic model (deepseek/openai/...) passes the early gate and
  // BUILDS a client even with no provider key — its key is checked lazily at chat time. The
  // create-callback rethrow is then the ONLY thing standing between "explicit unusable model"
  // and a silent degrade. This test locks that backstop into a contract: the client builds
  // (proving the deviation), and create() HARD-ERRORS (proving it never degrades to the
  // 'no LLM available' stub). A future refactor that turns this into a graceful path fails here.
  test('D1 backstop: explicit non-anthropic model, no key → BUILDS then create() THROWS (never a stub)', async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: undefined, DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined, GBRAIN_HOME: emptyHome() },
      async () => {
        resetGateway();  // unconfigured → gateway.chat() throws AIConfigError at create()
        // deepseek:deepseek-chat passes validateModelId (real recipe + chat touchpoint) — the
        // A9 non-anthropic model. probeChatModel returns ok (no anthropic key check) → builds.
        const client = await __thinkAdapter.tryBuildGatewayClient(
          'deepseek:deepseek-chat', { explicitModel: true },
        );
        expect(client).not.toBeNull();  // proves the early gate did NOT pre-reject non-anthropic
        const params: any = {
          model: 'deepseek:deepseek-chat',
          max_tokens: 16,
          system: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
        };
        // The backstop fires: explicit → AIConfigError rethrown, NOT the graceful sentinel.
        await expect(client!.create(params)).rejects.toThrow();
      },
    );
  });
});

describe('think gateway adapter — current-generation recipe models', () => {
  test('builds clients for Opus 4.8 / Sonnet 5 / Fable 5 (recipe-list refresh)', async () => {
    // Regression guard: these GA models were absent from the recipe allowlist,
    // so a tier-configured deep model degraded think to the no-LLM stub.
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-fake' }, async () => {
      for (const id of [
        'anthropic:claude-opus-4-8',
        'anthropic:claude-sonnet-5',
        'anthropic:claude-fable-5',
      ]) {
        const client = await __thinkAdapter.tryBuildGatewayClient(id);
        expect(client).not.toBeNull();
      }
    });
  });
});

describe('think gateway adapter — graceful fallback shape', () => {
  test('buildGracefulMessage produces a parseable Anthropic.Message-shaped object', () => {
    const m = __thinkAdapter.buildGracefulMessage('anthropic:claude-opus-4-7');
    expect(m.type).toBe('message');
    expect(m.role).toBe('assistant');
    expect(m.content[0].type).toBe('text');
    expect(m.content[0].text).toContain('no LLM available');
    expect(m.content[0].text).toContain('gbrain config');
    expect(m.usage.input_tokens).toBe(0);
    expect(m.usage.output_tokens).toBe(0);
    expect(m.stop_reason).toBe('end_turn');
  });
});
