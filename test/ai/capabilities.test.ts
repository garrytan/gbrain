import { describe, it, expect } from 'bun:test';
import { getProviderCapabilities, classifyCapabilities } from '../../src/core/ai/capabilities.ts';

describe('getProviderCapabilities (v0.38 Slice 1 — D6/D7 recipe-driven capabilities)', () => {
  it('returns full capabilities for Anthropic (canonical reference)', () => {
    const caps = getProviderCapabilities('anthropic:claude-sonnet-4-6');
    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.supportsPromptCaching).toBe(true);
    expect(caps.supportsParallelTools).toBe(true);
    expect(caps.maxContext).toBe(200000);
  });

  it('returns capabilities for OpenAI (automatic prefix caching counts)', () => {
    const caps = getProviderCapabilities('openai:gpt-5.2');
    expect(caps.supportsToolCalling).toBe(true);
    // Automatic server-side caching counts, same as the OpenRouter OpenAI
    // routes below — otherwise the identical model reads as cache-capable
    // through OpenRouter and cache-less natively.
    expect(caps.supportsPromptCaching).toBe(true);
    expect(caps.maxContext).toBe(1_050_000); // gpt-5.6 family window (recipe-driven)
  });

  it('returns local chat capabilities for Ollama without tool-loop support', () => {
    const caps = getProviderCapabilities('ollama:qwen3:8b');
    expect(caps.supportsToolCalling).toBe(false);
    expect(caps.supportsPromptCaching).toBe(false);
    expect(caps.supportsParallelTools).toBe(false);
  });

  it('returns capabilities for Google Gemini', () => {
    const caps = getProviderCapabilities('google:gemini-1.5-pro');
    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.supportsPromptCaching).toBe(false);
    expect(caps.maxContext).toBe(1000000); // Gemini 1.5 Pro
  });

  it('returns full capabilities for a local llama-server model', () => {
    const caps = getProviderCapabilities('llama-server:qwen-local-cache-probe');
    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.supportsPromptCaching).toBe(true);
    expect(caps.supportsParallelTools).toBe(true);
  });

  it('marks OpenRouter OpenAI/Anthropic routes as cache-capable (per-model predicate)', () => {
    const openaiCaps = getProviderCapabilities('openrouter:openai/gpt-5.2');
    expect(openaiCaps.supportsToolCalling).toBe(true);
    expect(openaiCaps.supportsPromptCaching).toBe(true);

    const anthropicCaps = getProviderCapabilities('openrouter:anthropic/claude-sonnet-4.6');
    expect(anthropicCaps.supportsToolCalling).toBe(true);
    expect(anthropicCaps.supportsPromptCaching).toBe(true);
  });

  it('does not mark every OpenRouter route as cache-capable', () => {
    // A family the predicate deliberately does not list — the point is that it
    // stays an allow-list rather than becoming a blanket true.
    const caps = getProviderCapabilities('openrouter:google/gemini-3-flash-preview');
    expect(caps.supportsToolCalling).toBe(true);
    expect(caps.supportsPromptCaching).toBe(false);
  });

  it('returns local chat capabilities for Ollama without tool-loop support', () => {
    const caps = getProviderCapabilities('ollama:qwen2.5-coder:14b');
    expect(caps.supportsToolCalling).toBe(false);
    expect(caps.supportsPromptCaching).toBe(false);
    expect(caps.supportsParallelTools).toBe(false);
  });

  it('honors Anthropic alias (undated → dated)', () => {
    const caps = getProviderCapabilities('anthropic:claude-haiku-4-5');
    expect(caps.supportsToolCalling).toBe(true);
  });

  it('throws for unknown provider', () => {
    expect(() => getProviderCapabilities('madeup-provider:foo')).toThrow();
  });

  it('throws for embedding-only provider (no chat touchpoint)', () => {
    expect(() => getProviderCapabilities('voyage:voyage-3-large')).toThrow(
      /does not offer a chat touchpoint/,
    );
  });

  it('throws for missing colon', () => {
    expect(() => getProviderCapabilities('claude-sonnet-4-6')).toThrow(/missing a provider prefix/);
  });

  it('mirrors the recipe supports_subagent_loop declaration', () => {
    // Declared true — loop-capable.
    expect(getProviderCapabilities('anthropic:claude-sonnet-4-6').supportsSubagentLoop).toBe(true);
    expect(getProviderCapabilities('deepseek:deepseek-v4-flash').supportsSubagentLoop).toBe(true);
    // Declared false — tools work, but tool_call_ids aren't replay-stable.
    expect(getProviderCapabilities('moonshot:kimi-k2.5').supportsSubagentLoop).toBe(false);
    expect(getProviderCapabilities('mistral:mistral-large-latest').supportsSubagentLoop).toBe(false);
    expect(getProviderCapabilities('openrouter:openai/gpt-5.2').supportsSubagentLoop).toBe(false);
  });
});

describe('classifyCapabilities (D6 — three-tier capability verdict)', () => {
  it('returns ok for fully-capable Anthropic models', () => {
    expect(classifyCapabilities('anthropic:claude-sonnet-4-6')).toBe('ok');
    expect(classifyCapabilities('anthropic:claude-opus-4-7')).toBe('ok');
  });

  it('returns ok for a cache-capable local llama-server model', () => {
    expect(classifyCapabilities('llama-server:qwen-local-cache-probe')).toBe('ok');
  });

  it('returns ok for providers that cache automatically', () => {
    // Pre-fix these were degraded:no_caching, which made
    // enforceSubagentCapable advise moving to an Anthropic model "for lower
    // cost on long loops" on providers that were already caching.
    expect(classifyCapabilities('openai:gpt-5.2')).toBe('ok');
    expect(classifyCapabilities('deepseek:deepseek-v4-flash')).toBe('ok');
  });

  it('returns unusable:no_tools for Ollama subagent loops', () => {
    expect(classifyCapabilities('ollama:qwen3:8b')).toBe('unusable:no_tools');
  });

  it('returns degraded:no_caching for Google Gemini', () => {
    expect(classifyCapabilities('google:gemini-1.5-pro')).toBe('degraded:no_caching');
  });

  it('allows OpenRouter Anthropic routes for the subagent loop and refuses other OR families', () => {
    // Anthropic-via-OR shares the Anthropic tool envelope; replay keys off
    // gbrain_tool_use_id. Other proxied families stay refused until they get
    // their own live abort/retry pin.
    expect(classifyCapabilities('openrouter:anthropic/claude-sonnet-4.6')).toBe('ok');
    expect(classifyCapabilities('openrouter:anthropic/claude-haiku-4.5')).toBe('ok');
    expect(classifyCapabilities('openrouter:openai/gpt-5.2')).toBe('unusable:no_subagent_loop');
    expect(classifyCapabilities('openrouter:deepseek/deepseek-chat')).toBe('unusable:no_subagent_loop');
  });

  it('returns unusable:no_subagent_loop when tools work but the recipe declares the loop unsupported', () => {
    // moonshot + mistral declare supports_tools: true, supports_subagent_loop: false.
    expect(classifyCapabilities('moonshot:kimi-k2.5')).toBe('unusable:no_subagent_loop');
    expect(classifyCapabilities('mistral:mistral-large-latest')).toBe('unusable:no_subagent_loop');
  });

  it('keeps unusable:no_tools precedence when tool calling is missing too', () => {
    // minimax + nvidia declare BOTH supports_tools: false and
    // supports_subagent_loop: false — the stronger no_tools verdict wins.
    expect(classifyCapabilities('minimax:MiniMax-M2.5')).toBe('unusable:no_tools');
    expect(classifyCapabilities('nvidia:nvidia/nemotron-3-super-120b-a12b')).toBe('unusable:no_tools');
  });

  it('returns unusable:no_tools for Ollama subagent loops', () => {
    expect(classifyCapabilities('ollama:qwen2.5-coder:14b')).toBe('unusable:no_tools');
  });

  it('OpenAI caching is per model generation, not provider-wide', () => {
    // Recipe model lists are advisory, so any id a user configures lands here.
    // Automatic caching starts at the gpt-4o / gpt-4.1 / o-series generation;
    // older ids really do run hot and must keep their cost warning.
    const CACHES = [
      'gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-08-06',
      'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4.5-preview',
      'gpt-5', 'gpt-5.2', 'gpt-5.6-terra',
      'o1', 'o1-mini', 'o4-mini',
      'ft:gpt-4o-mini:acme::abc', // fine-tunes inherit the base model
    ];
    // Legacy families, plus ids that merely SHARE a prefix — the boundary
    // anchors are what stop those from inheriting a family's answer.
    const RUNS_HOT = [
      'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo',
      'gpt-4oops', 'gpt-5bogus', 'o9anything',
      'ft:gpt-4-turbo:acme::x',
    ];
    for (const id of CACHES) {
      expect(getProviderCapabilities(`openai:${id}`).supportsPromptCaching, id).toBe(true);
    }
    for (const id of RUNS_HOT) {
      expect(getProviderCapabilities(`openai:${id}`).supportsPromptCaching, id).toBe(false);
    }
  });

  it('a provider reachable two ways reports the same caching verdict either way', () => {
    // The bug this guards: a provider's caching behavior is a property of the
    // provider, not of the route taken to reach it. Letting the native recipe
    // and the OpenRouter predicate drift apart is what made the same model read
    // as cache-capable one way and cache-less the other.
    for (const [native, routed] of [
      ['openai:gpt-5.2', 'openrouter:openai/gpt-5.2'],
      // The negative side matters just as much: a legacy id must be cache-less
      // on BOTH routes, which is only structurally true because the two share
      // one predicate.
      ['openai:gpt-4-turbo', 'openrouter:openai/gpt-4-turbo'],
      ['deepseek:deepseek-v4-flash', 'openrouter:deepseek/deepseek-chat'],
      ['anthropic:claude-sonnet-4-6', 'openrouter:anthropic/claude-sonnet-4.6'],
    ] as const) {
      expect(
        getProviderCapabilities(routed).supportsPromptCaching,
        `${routed} disagrees with ${native}`,
      ).toBe(getProviderCapabilities(native).supportsPromptCaching);
    }
  });

  it('returns unknown for unrecognized providers', () => {
    expect(classifyCapabilities('madeup:something')).toBe('unknown');
  });

  it('returns unknown for embedding-only providers (chat touchpoint missing)', () => {
    // Voyage has no chat touchpoint → throws inside getProviderCapabilities
    // → classifyCapabilities catches → returns 'unknown'.
    expect(classifyCapabilities('voyage:voyage-3-large')).toBe('unknown');
  });
});
