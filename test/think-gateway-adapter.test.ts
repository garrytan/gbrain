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
import { withEnv } from './helpers/with-env.ts';

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
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      const client = await __thinkAdapter.tryBuildGatewayClient('claude-opus-4-7');
      expect(client).toBeNull();
    });
  });

  test('hasAnthropicKey reads process.env', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-key' }, async () => {
      expect(__thinkAdapter.hasAnthropicKey()).toBe(true);
    });
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      expect(__thinkAdapter.hasAnthropicKey()).toBe(false);
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
