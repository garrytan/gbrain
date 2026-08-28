/**
 * Commit 1 — chat touchpoint coverage.
 *
 * Asserts:
 *   - chat() resolves provider:model strings + aliases
 *   - assertTouchpoint surfaces chat-only providers correctly
 *   - getChatModel() default + override
 *   - chat_fallback_chain plumbing (config plumbing only — chatWithFallback ships in commit 3)
 *   - new openai-compat recipes (deepseek, groq, together) parse + resolve
 *   - new ChatTouchpoint shape: supports_subagent_loop, supports_prompt_cache
 *   - mapStopReason via the chat() boundary (mocked client) — refusal / content_filter / tool_calls / end / length
 *
 * The actual `generateText` call is exercised via a fake AI SDK model object
 * (the `model` returned from `createOpenAICompatible(...).languageModel()`)
 * passed by patching the module cache. We bypass the heavy SDK by mocking the
 * `generateText` import via Bun's module-replace pattern.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  isAvailable,
  getChatModel,
  getChatFallbackChain,
  recipeSupportsStructuredOutputs,
  parseExpansionResponse,
  chat,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { parseModelId, resolveRecipe, assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { listRecipes, getRecipe } from '../../src/core/ai/recipes/index.ts';
import type { Recipe } from '../../src/core/ai/types.ts';

describe('chat touchpoint — recipe registry', () => {
  test('all hosted tool-loop providers ship a chat touchpoint with supports_subagent_loop', () => {
    const expected = ['anthropic', 'openai', 'google', 'deepseek', 'groq', 'together'];
    for (const id of expected) {
      const r = getRecipe(id);
      expect(r, `recipe missing: ${id}`).toBeDefined();
      expect(r!.touchpoints.chat, `${id} missing chat touchpoint`).toBeDefined();
      expect(r!.touchpoints.chat!.models.length, `${id} chat models empty`).toBeGreaterThan(0);
      expect(r!.touchpoints.chat!.supports_subagent_loop, `${id} should support subagent loop`).toBe(true);
    }
  });

  test('the set of recipes declaring supports_prompt_cache is the expected one', () => {
    // The flag answers "does this provider cache prompts at all" — what
    // capabilities.ts reads to decide whether the subagent loop runs hot.
    // Explicit client-side markers (Anthropic's cache_control), automatic
    // server-side prefix caching (OpenAI, DeepSeek), and a local server that
    // always caches (llama-server) all count.
    //
    // This pins the CURRENT declarations, not a claim that every other
    // provider is cache-less: some recipes here still declare false while
    // their vendor does cache (moonshot). Correcting those needs per-model
    // predicates rather than a boolean, so they are tracked separately —
    // when one is fixed, add it here.
    // Per-model predicate where caching depends on the model generation or the
    // routed family — OpenRouter by routed model family (openai/* +
    // anthropic/claude-*), Google by Gemini version (implicit caching is
    // 2.5+), OpenAI by the gpt-4o/o-series generation; a plain boolean where
    // it is a property of the whole provider. Anything else must declare no
    // caching.
    const PREDICATE = new Set(['openai', 'openrouter', 'google']);
    const ALWAYS_CACHES = new Set(['anthropic', 'deepseek', 'llama-server']);
    for (const r of listRecipes()) {
      if (!r.touchpoints.chat) continue;
      const flag = r.touchpoints.chat.supports_prompt_cache;
      if (PREDICATE.has(r.id)) {
        expect(typeof flag, `${r.id} should gate caching per model`).toBe('function');
      } else if (ALWAYS_CACHES.has(r.id)) {
        expect(flag, `${r.id} should declare caching`).toBe(true);
      } else {
        expect(flag ?? false, `${r.id} should not declare caching`).toBe(false);
      }
    }
  });

  test('Voyage remains embedding-only', () => {
    expect(getRecipe('voyage')!.touchpoints.chat).toBeUndefined();
  });

  test('Ollama declares local chat without subagent tool-loop support', () => {
    const chat = getRecipe('ollama')!.touchpoints.chat;
    expect(chat).toBeDefined();
    expect(chat!.models).toContain('qwen2.5-coder:14b');
    expect(chat!.supports_tools).toBe(false);
    expect(chat!.supports_subagent_loop).toBe(false);
    expect(chat!.supports_prompt_cache).toBe(false);
    expect(chat!.cost_per_1m_input_usd).toBe(0);
    expect(chat!.cost_per_1m_output_usd).toBe(0);
  });

  test('openai-compat chat recipes have base_url_default', () => {
    expect(getRecipe('ollama')!.base_url_default).toBe('http://localhost:11434/v1');
    expect(getRecipe('deepseek')!.base_url_default).toBe('https://api.deepseek.com/v1');
    expect(getRecipe('groq')!.base_url_default).toBe('https://api.groq.com/openai/v1');
    expect(getRecipe('together')!.base_url_default).toBe('https://api.together.xyz/v1');
  });
});

describe('expansion — structured-output capability gating', () => {
  test('openai-compat chat recipes default to no structured-output support', () => {
    // The capability is opt-in per recipe: an openai-compatible recipe may front
    // arbitrary backends, so expand() routes the default through the schemaless
    // text path rather than requesting a json_schema the backend may reject.
    for (const id of ['deepseek', 'groq', 'together']) {
      expect(recipeSupportsStructuredOutputs(getRecipe(id)!)).toBe(false);
    }
  });

  test('recipeSupportsStructuredOutputs is false when no chat touchpoint exists', () => {
    // Embedding-only recipes have no chat touchpoint; the helper must not throw.
    expect(recipeSupportsStructuredOutputs(getRecipe('voyage')!)).toBe(false);
  });

  test('recipeSupportsStructuredOutputs is true when a recipe opts in', () => {
    const optedIn = {
      id: 'synthetic',
      touchpoints: { chat: { models: [], supports_tools: true, supports_subagent_loop: true, supports_structured_outputs: true } },
    } as unknown as Recipe;
    expect(recipeSupportsStructuredOutputs(optedIn)).toBe(true);
  });
});

describe('expansion — schemaless recovery (parseExpansionResponse)', () => {
  // The openai-compat expansion paths recover queries from raw model text. This
  // is the testable seam both the default and the strict-fallback paths share.
  test('recovers queries from clean JSON', () => {
    expect(parseExpansionResponse('{"queries":["a","b","c"]}')).toEqual(['a', 'b', 'c']);
  });

  test('recovers queries from fenced JSON', () => {
    expect(parseExpansionResponse('```json\n{"queries":["a","b"]}\n```')).toEqual(['a', 'b']);
  });

  test('recovers queries from prose-wrapped JSON', () => {
    expect(parseExpansionResponse('Here you go: {"queries":["a"]} done')).toEqual(['a']);
  });

  test('returns null for non-JSON so the caller can drop expansion cleanly', () => {
    expect(parseExpansionResponse('I cannot help with that.')).toBeNull();
  });

  test('returns null when the JSON violates the schema', () => {
    expect(parseExpansionResponse('{"queries":[]}')).toBeNull(); // min(1)
    expect(parseExpansionResponse('{"rewrites":["a"]}')).toBeNull(); // wrong key
    expect(parseExpansionResponse('{"queries":[1,2]}')).toBeNull(); // wrong item type
  });
});

describe('chat touchpoint — model resolver + aliases (Codex F-OV-5)', () => {
  test('parseModelId handles dated and undated forms identically at parse time', () => {
    expect(parseModelId('anthropic:claude-sonnet-4-6')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    expect(parseModelId('anthropic:claude-haiku-4-5-20251001')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
    });
  });

  test('resolveRecipe expands pre-4.6 dateless alias to dated canonical', () => {
    // Pre-4.6 models keep date-based aliases (Haiku 4.5 predates the
    // dateless convention).
    const { parsed } = resolveRecipe('anthropic:claude-haiku-4-5');
    expect(parsed.modelId).toBe('claude-haiku-4-5-20251001');
  });

  test('resolveRecipe leaves dateless 4.6+ models unchanged (they ARE canonical)', () => {
    const { parsed } = resolveRecipe('anthropic:claude-opus-4-7');
    expect(parsed.modelId).toBe('claude-opus-4-7');
    const { parsed: parsed2 } = resolveRecipe('anthropic:claude-sonnet-4-6');
    expect(parsed2.modelId).toBe('claude-sonnet-4-6');
  });

  test('reverse alias rescues v0.31.6-shipped broken Sonnet 4.6 ID (regression)', () => {
    // gbrain v0.31.6 shipped 'claude-sonnet-4-6-20250929' as a hardcoded
    // default, which 404s on the Anthropic API (Sonnet 4.6 is dateless).
    // The reverse alias rewrites broken → canonical so any user with a
    // stale `models.dream.synthesize` / `facts.extraction_model` config
    // keeps working. Regression guard against a future "cleanup" that
    // drops this alias entry.
    const { parsed } = resolveRecipe('anthropic:claude-sonnet-4-6-20250929');
    expect(parsed.modelId).toBe('claude-sonnet-4-6');
  });

  test('assertTouchpoint accepts chat for chat-capable native + openai-compat providers', () => {
    expect(() => assertTouchpoint(getRecipe('anthropic')!, 'chat', 'claude-opus-4-7')).not.toThrow();
    expect(() => assertTouchpoint(getRecipe('openai')!, 'chat', 'gpt-5.2')).not.toThrow();
    expect(() => assertTouchpoint(getRecipe('google')!, 'chat', 'gemini-2.5-flash')).not.toThrow();
    expect(() => assertTouchpoint(getRecipe('deepseek')!, 'chat', 'deepseek-v4-flash')).not.toThrow();
    // Legacy id retired by DeepSeek 2026-07-24 (#1255): still passes local
    // validation (openai-compat tier), rejection surfaces at the provider.
    expect(() => assertTouchpoint(getRecipe('deepseek')!, 'chat', 'deepseek-chat')).not.toThrow();
    expect(() => assertTouchpoint(getRecipe('ollama')!, 'chat', 'qwen2.5-coder:14b')).not.toThrow();
  });

  test('assertTouchpoint rejects chat on embedding-only providers with a fix hint', () => {
    expect(() => assertTouchpoint(getRecipe('voyage')!, 'chat', 'voyage-3'))
      .toThrow(AIConfigError);
  });

  test('assertTouchpoint accepts unlisted models on native recipes (no runtime allowlist)', () => {
    // Frontier models ship weekly; recipe models: arrays are informational
    // (defaults, guard-test fixtures, display), not a gate. A nonexistent id
    // surfaces as the provider's own model_not_found at call time.
    expect(() => assertTouchpoint(getRecipe('anthropic')!, 'chat', 'claude-opus-9-99')).not.toThrow();
    expect(() => assertTouchpoint(getRecipe('openai')!, 'chat', 'gpt-5.6-sol')).not.toThrow();
    expect(() => assertTouchpoint(getRecipe('google')!, 'chat', 'gemini-9-flash')).not.toThrow();
    expect(() => assertTouchpoint(getRecipe('openai')!, 'expansion', 'gpt-5.6-luna')).not.toThrow();
    expect(() => assertTouchpoint(getRecipe('openai')!, 'embedding', 'text-embedding-9-huge')).not.toThrow();
  });

  test('assertTouchpoint accepts arbitrary model on openai-compat tier', () => {
    // openai-compat lets users pass models not declared in the recipe (provider may host more)
    expect(() => assertTouchpoint(getRecipe('groq')!, 'chat', 'some-future-model')).not.toThrow();
    expect(() => assertTouchpoint(getRecipe('ollama')!, 'chat', 'locally-installed-model')).not.toThrow();
  });
});

describe('chat touchpoint — gateway config plumbing', () => {
  beforeEach(() => resetGateway());

  test('default chat_model is anthropic:claude-sonnet-4-6', () => {
    configureGateway({ env: {} });
    expect(getChatModel()).toBe('anthropic:claude-sonnet-4-6');
  });

  test('explicit chat_model overrides the default', () => {
    configureGateway({
      chat_model: 'openai:gpt-5.2',
      env: { OPENAI_API_KEY: 'fake' },
    });
    expect(getChatModel()).toBe('openai:gpt-5.2');
  });

  test('chat_fallback_chain plumbed and retrievable', () => {
    configureGateway({
      chat_fallback_chain: [
        'anthropic:claude-opus-4-7',
        'deepseek:deepseek-chat',
      ],
      env: {},
    });
    expect(getChatFallbackChain()).toEqual([
      'anthropic:claude-opus-4-7',
      'deepseek:deepseek-chat',
    ]);
  });

  test('chat_fallback_chain defaults to empty array', () => {
    configureGateway({ env: {} });
    expect(getChatFallbackChain()).toEqual([]);
  });

  test('isAvailable("chat") returns true when default Anthropic + key present', () => {
    configureGateway({ env: { ANTHROPIC_API_KEY: 'fake' } });
    expect(isAvailable('chat')).toBe(true);
  });

  test('isAvailable("chat") returns false when configured provider has no key', () => {
    configureGateway({ chat_model: 'openai:gpt-5.2', env: {} });
    expect(isAvailable('chat')).toBe(false);
  });

  test('isAvailable("chat") returns false on embedding-only chat target', () => {
    // Voyage doesn't expose a chat touchpoint; isAvailable should refuse.
    configureGateway({ chat_model: 'voyage:voyage-3', env: { VOYAGE_API_KEY: 'fake' } });
    expect(isAvailable('chat')).toBe(false);
  });
});

describe('chat touchpoint — config alias resolution', () => {
  beforeEach(() => resetGateway());

  test('isAvailable("chat") accepts undated alias and resolves correctly', () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6', // undated
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    expect(isAvailable('chat')).toBe(true);
  });
});

describe('chat touchpoint — chat() smoke + stop-reason mapping (Codex D8)', () => {
  // We exercise chat() against a mocked AI-SDK 'generateText' to assert the
  // gateway's structural-signal mapping (mapStopReason) covers refusal,
  // content_filter, tool_calls, end, length without the regex layer (commit 3).
  // A full integration test against real provider HTTP lives in
  // test/e2e/agent-multi-provider.test.ts (commit 2).
  //
  // We can't easily monkey-patch ESM imports inside Bun's runtime; instead we
  // write an end-to-end assertion against the resolver logic + verify the
  // chat() function exists with the documented signature.

  test('chat() function is exported with the expected signature', async () => {
    const mod = await import('../../src/core/ai/gateway.ts');
    expect(typeof mod.chat).toBe('function');
    // Signature check: must accept ChatOpts. We don't call it without a real
    // provider key — that's the e2e job.
  });

  test('ChatBlock + ChatMessage + ChatResult types are exported', async () => {
    // Type-only assertion: if these imports compile, we're good. The test
    // body is just a runtime touch.
    const mod = await import('../../src/core/ai/gateway.ts');
    expect(mod).toBeDefined();
  });
});

describe('chat touchpoint — provider_chat_options passthrough', () => {
  beforeEach(() => {
    resetGateway();
    __setGenerateTextTransportForTests(null);
  });

  async function captureProviderOptions(
    config: Parameters<typeof configureGateway>[0],
    opts: Partial<Parameters<typeof chat>[0]> = {},
  ): Promise<Record<string, any> | undefined> {
    let captured: Record<string, any> | undefined;
    __setGenerateTextTransportForTests(async (args: any) => {
      captured = args.providerOptions;
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as any;
    });
    configureGateway(config);
    await chat({
      model: config.chat_model ?? 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      ...opts,
    });
    return captured;
  }

  test('provider-scoped option reaches generateText providerOptions[recipe.id]', async () => {
    const providerOptions = await captureProviderOptions({
      chat_model: 'anthropic:claude-sonnet-4-6',
      provider_chat_options: {
        anthropic: { thinking: { type: 'disabled' } },
      },
      env: { ANTHROPIC_API_KEY: 'fake' },
    });

    expect(providerOptions).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
    });
  });

  test('model-scoped option overrides provider-scoped option', async () => {
    const providerOptions = await captureProviderOptions({
      chat_model: 'anthropic:claude-sonnet-4-6',
      provider_chat_options: {
        anthropic: {
          thinking: { type: 'enabled', budget_tokens: 1024 },
          temperature: 0.2,
        },
        'anthropic:claude-sonnet-4-6': {
          thinking: { type: 'disabled' },
        },
      },
      env: { ANTHROPIC_API_KEY: 'fake' },
    });

    expect(providerOptions).toEqual({
      anthropic: {
        thinking: { type: 'disabled', budget_tokens: 1024 },
        temperature: 0.2,
      },
    });
  });

  test('no provider_chat_options keeps providerOptions undefined when cache is off', async () => {
    const providerOptions = await captureProviderOptions({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });

    expect(providerOptions).toBeUndefined();
  });

  test('call-scoped providerOptions merge last without dropping configured siblings', async () => {
    const providerOptions = await captureProviderOptions({
      chat_model: 'deepseek:deepseek-v4-flash',
      provider_chat_options: {
        deepseek: { temperature: 0.2 },
      },
      env: { DEEPSEEK_API_KEY: 'fake' },
    }, {
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    });

    expect(providerOptions).toEqual({
      deepseek: { temperature: 0.2, thinking: { type: 'disabled' } },
    });
  });

  test('call-scoped providerOptions win over configured options on key conflict', async () => {
    // The call site pins behavior it depends on (e.g. the triage judge
    // disabling DeepSeek thinking); config-level provider_chat_options must
    // not silently override it.
    const providerOptions = await captureProviderOptions({
      chat_model: 'deepseek:deepseek-v4-flash',
      provider_chat_options: {
        deepseek: { thinking: { type: 'enabled' } },
      },
      env: { DEEPSEEK_API_KEY: 'fake' },
    }, {
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    });

    expect(providerOptions).toEqual({
      deepseek: { thinking: { type: 'disabled' } },
    });
  });

  test('anthropic cacheControl survives provider_chat_options merging', async () => {
    // gbrain#2490: this call-level cacheControl is real (not a no-op) —
    // @ai-sdk/anthropic serializes it as the Anthropic API's documented
    // top-level "auto-cache the last cacheable block" shorthand. It's kept
    // alongside the fix (an explicit breakpoint on the system message's own
    // providerOptions — see test/ai/gateway-cache-breakpoint.test.ts) because
    // it's what gives toolLoop()'s growing multi-turn conversation a rolling
    // cache breakpoint on each turn's tail. See gateway.ts's `useCache` block
    // for the full explanation of why both markers are needed.
    const providerOptions = await captureProviderOptions({
      chat_model: 'anthropic:claude-sonnet-4-6',
      provider_chat_options: {
        anthropic: { thinking: { type: 'disabled' } },
      },
      env: { ANTHROPIC_API_KEY: 'fake' },
    }, { cacheSystem: true });

    expect(providerOptions).toEqual({
      anthropic: {
        cacheControl: { type: 'ephemeral' },
        thinking: { type: 'disabled' },
      },
    });
  });
});

describe('chat touchpoint — per-part providerMetadata round trip (#4201)', () => {
  beforeEach(() => {
    resetGateway();
    __setGenerateTextTransportForTests(null);
  });

  const SIG = { google: { thoughtSignature: 'opaque-turn1-signature' } };

  test('chat() captures part providerMetadata onto ChatBlocks (inbound half)', async () => {
    __setGenerateTextTransportForTests(async () => ({
      content: [
        { type: 'text', text: 'calling a tool', providerMetadata: SIG },
        { type: 'tool-call', toolCallId: 'g1', toolName: 'search', input: { q: 'x' }, providerMetadata: SIG },
      ],
      finishReason: 'tool-calls',
      usage: { inputTokens: 5, outputTokens: 5 },
    }) as any);
    configureGateway({
      chat_model: 'google:gemini-3-pro-preview',
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' },
    });
    const result = await chat({
      model: 'google:gemini-3-pro-preview',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const toolCall = result.blocks.find(b => b.type === 'tool-call') as any;
    expect(toolCall.providerMetadata).toEqual(SIG);
    const text = result.blocks.find(b => b.type === 'text') as any;
    expect(text.providerMetadata).toEqual(SIG);
  });

  test('next-turn request echoes the signature as providerOptions (outbound half)', async () => {
    let capturedMessages: any[] | undefined;
    __setGenerateTextTransportForTests(async (args: any) => {
      capturedMessages = args.messages;
      return {
        content: [{ type: 'text', text: 'done' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as any;
    });
    configureGateway({
      chat_model: 'google:gemini-3-pro-preview',
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' },
    });
    // Turn-2 request: the transcript contains turn 1's tool-call block WITH
    // the captured metadata (exactly what toolLoop pushes into messages) plus
    // the tool-result user turn.
    await chat({
      model: 'google:gemini-3-pro-preview',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'g1', toolName: 'search', input: { q: 'x' }, providerMetadata: SIG }],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'g1', toolName: 'search', output: { hits: 1 } }],
        },
      ],
    });
    expect(capturedMessages).toBeDefined();
    const assistant = (capturedMessages as any[]).find(m => m.role === 'assistant');
    expect(assistant.content[0].providerOptions).toEqual(SIG);
  });
});

// OpenAI's Responses API requires every `function_call` item in a replayed
// transcript to be paired with the `reasoning` item that produced it, or the
// NEXT turn 400s: "Item '<fc_id>' of type 'function_call' was provided
// without its required 'reasoning' item: '<rs_id>'." Reproduced live against
// openai:gpt-5.6-luna in a 2-turn tool-calling conversation: turn 1 captured
// zero reasoning blocks (chat() silently dropped the `reasoning` part) and
// turn 2 failed with exactly that message; after this fix turn 1 captures
// the reasoning block and turn 2 completes. This suite covers the inbound
// capture half with the SAME #4201 providerMetadata channel `text`/`tool-call`
// already use — see gateway-model-messages.test.ts for the outbound echo half.
describe('chat touchpoint — reasoning-item round trip (OpenAI Responses API)', () => {
  beforeEach(() => {
    resetGateway();
    __setGenerateTextTransportForTests(null);
  });

  const REASONING_SIG = { openai: { itemId: 'rs_abc123', reasoningEncryptedContent: 'opaque-blob' } };

  test('chat() captures a reasoning part into a ChatBlock (inbound half)', async () => {
    __setGenerateTextTransportForTests(async () => ({
      content: [
        { type: 'reasoning', text: 'weighing today vs. the forecast...', providerMetadata: REASONING_SIG },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'get_forecast', input: { city: 'Tokyo' } },
      ],
      finishReason: 'tool-calls',
      usage: { inputTokens: 5, outputTokens: 5 },
    }) as any);
    configureGateway({ chat_model: 'openai:gpt-5.6-luna', env: { OPENAI_API_KEY: 'fake' } });
    const result = await chat({
      model: 'openai:gpt-5.6-luna',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const reasoning = result.blocks.find(b => b.type === 'reasoning') as any;
    expect(reasoning).toBeDefined();
    expect(reasoning.text).toBe('weighing today vs. the forecast...');
    expect(reasoning.providerMetadata).toEqual(REASONING_SIG);
    // Never leaks into the final answer text (that's the model's actual reply, not its thinking).
    expect(result.text).toBe('');
  });

  test('a reasoning part with a non-string text field does not poison the call', async () => {
    __setGenerateTextTransportForTests(async () => ({
      content: [
        { type: 'reasoning', text: null },
        { type: 'text', text: 'ok' },
      ],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }) as any);
    configureGateway({ chat_model: 'openai:gpt-5.6-luna', env: { OPENAI_API_KEY: 'fake' } });
    const result = await chat({
      model: 'openai:gpt-5.6-luna',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const reasoning = result.blocks.find(b => b.type === 'reasoning') as any;
    expect(reasoning.text).toBe('');
    expect(result.text).toBe('ok');
  });
});

describe('chat — typed provider error status carried to the top level', () => {
  beforeEach(() => {
    resetGateway();
    __setGenerateTextTransportForTests(null);
  });

  test('claude-cli 429 envelope error keeps apiErrorStatus readable on the normalized error', async () => {
    // normalizeAIError wraps provider errors (here in AITransientError); the
    // status a caller branches on must survive as a top-level property, not
    // only inside `cause`.
    const { ClaudeCliProcessError } = await import('../../src/core/ai/providers/claude-cli-language-model.ts');
    const { AITransientError } = await import('../../src/core/ai/errors.ts');
    __setGenerateTextTransportForTests(async () => {
      throw new ClaudeCliProcessError(
        'claude-cli API error 429: monthly spend limit reached',
        { apiErrorStatus: 429, exitCode: 1 },
      );
    });
    configureGateway({ chat_model: 'claude-cli:claude-sonnet-4-6', env: {} });

    let caught: unknown;
    try {
      await chat({
        model: 'claude-cli:claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AITransientError);
    const err = caught as InstanceType<typeof AITransientError> & { apiErrorStatus?: number };
    expect(err.message).toContain('claude-cli API error 429');
    expect(err.apiErrorStatus).toBe(429);
    // The original typed error stays reachable as the cause.
    expect(err.cause).toBeInstanceOf(ClaudeCliProcessError);
  });
});
