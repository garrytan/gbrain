/**
 * gbrain#2490 — gateway.chat() never caches a stable system prompt across
 * varying single-turn calls (page-summary, skillopt, enrich).
 *
 * Root cause: `chat()` passed `system` as a bare string and relied solely on
 * a CALL-LEVEL `providerOptions.anthropic.cacheControl`. On `ai@6` +
 * `@ai-sdk/anthropic@3.x`, that call-level marker is real — it's serialized
 * as a top-level `cache_control` field on the Anthropic request body, which
 * the Messages API resolves via its documented "auto-cache the LAST
 * cacheable block in the request" shorthand (see Anthropic's prompt-caching
 * docs). For a single-turn call with a stable system prompt and a DIFFERENT
 * user message every time, "the last cacheable block" is that ever-varying
 * user message — every call WRITES a fresh cache entry there and never
 * READS a prior one, so `cache_read_input_tokens` stays 0 forever even
 * though a `cache_control` breakpoint genuinely reaches Anthropic.
 *
 * Fix: ALSO pass `system` as a `SystemModelMessage` object (`{ role:
 * 'system', content, providerOptions }`) when caching is requested — the
 * shape `ai` documents specifically for attaching provider options to the
 * system block — and mark the last tool def's own `providerOptions` too
 * (mirrors the already-correct raw-SDK path in `subagent.ts`). The
 * call-level marker is KEPT (not removed): it's what gives `toolLoop()`'s
 * growing multi-turn conversation a rolling cache breakpoint on each turn's
 * tail, which the explicit system/tool markers alone don't provide.
 *
 * These tests pin the FIX by inspecting the exact args handed to the
 * `generateText` transport (via `__setGenerateTextTransportForTests`),
 * not by asserting on `providerOptions` alone — that field is exactly what
 * the bug made you believe was sufficient.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  chat,
  configureGateway,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { OPENROUTER_CACHE_HEADER } from '../../src/core/ai/recipes/openrouter.ts';

afterAll(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
});

describe('gbrain#2490 — Anthropic cache breakpoint placement', () => {
  beforeEach(() => {
    resetGateway();
    __setGenerateTextTransportForTests(null);
  });

  async function captureTransportArgs(
    opts: Partial<Parameters<typeof chat>[0]> = {},
  ): Promise<any> {
    let captured: any;
    __setGenerateTextTransportForTests(async (args: any) => {
      captured = args;
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as any;
    });
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    await chat({
      model: 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      ...opts,
    });
    return captured;
  }

  test('cacheSystem:true puts a real breakpoint on the system block (SystemModelMessage, not a bare string)', async () => {
    const args = await captureTransportArgs({ system: 'You are a helpful assistant.', cacheSystem: true });

    // The regression: `system` used to stay a bare string forever, which
    // carries no per-block `providerOptions` — no breakpoint could ever land.
    expect(typeof args.system).not.toBe('string');
    expect(args.system).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  });

  test('cacheSystem:true ALSO keeps the call-level cache_control on top-level providerOptions (rolling-conversation cache for toolLoop)', async () => {
    const args = await captureTransportArgs({ system: 'SYS', cacheSystem: true });

    // Not removed: @ai-sdk/anthropic serializes this as the Anthropic API's
    // documented top-level "auto-cache the last cacheable block" shorthand,
    // which is what gives a growing multi-turn toolLoop() conversation a
    // rolling cache breakpoint on each turn's tail. The explicit
    // system-block marker (asserted above) is what actually fixes gbrain#2490
    // for single-turn callers — the two coexist, marking different blocks.
    expect(args.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
  });

  test('cacheSystem:true marks the LAST tool def with its own providerOptions.anthropic.cacheControl', async () => {
    const args = await captureTransportArgs({
      system: 'SYS',
      cacheSystem: true,
      tools: [
        { name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} } },
        { name: 'put_page', description: 'put_page', inputSchema: { type: 'object', properties: {} } },
      ],
    });

    expect(args.tools.search.providerOptions).toBeUndefined();
    expect(args.tools.put_page.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  test('cacheSystem:false (default) leaves system a byte-identical bare string — no behavior change', async () => {
    const args = await captureTransportArgs({ system: 'SYS', cacheSystem: false });
    expect(args.system).toBe('SYS');
    expect(args.providerOptions).toBeUndefined();
  });

  test('cacheSystem omitted entirely leaves system a byte-identical bare string — no behavior change', async () => {
    const args = await captureTransportArgs({ system: 'SYS' });
    expect(args.system).toBe('SYS');
    expect(args.providerOptions).toBeUndefined();
  });

  test('cacheSystem:true with no system prompt does not synthesize an empty cached system block', async () => {
    const args = await captureTransportArgs({ cacheSystem: true });
    expect(args.system).toBeUndefined();
  });

  test('cacheSystem:true with no tools does not throw and leaves tools undefined', async () => {
    const args = await captureTransportArgs({ system: 'SYS', cacheSystem: true });
    expect(args.tools).toBeUndefined();
  });

  test('cacheSystem:true on a recipe that declares no caching leaves system a bare string', async () => {
    // This test needs SOME recipe that declares no caching; it is not a claim
    // about what Google's API does. If this guard ever fails, that recipe was
    // corrected — re-point the test at another undeclared one, don't delete it.
    const { getProviderCapabilities } = await import('../../src/core/ai/capabilities.ts');
    expect(getProviderCapabilities('google:gemini-1.5-pro').supportsPromptCaching).toBe(false);

    let captured: any;
    __setGenerateTextTransportForTests(async (args: any) => {
      captured = args;
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as any;
    });
    configureGateway({
      chat_model: 'google:gemini-1.5-pro',
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' },
    });
    await chat({
      model: 'google:gemini-1.5-pro',
      system: 'SYS',
      cacheSystem: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    // useCache is false regardless of the caller's request, so no breakpoint
    // machinery runs at all.
    expect(captured.system).toBe('SYS');
  });

  test('an auto-caching provider gets the same shape the OpenRouter OpenAI route already gets', async () => {
    // Native OpenAI and OpenRouter's openai/* routes are the same upstream
    // models with the same automatic prefix caching, and
    // `openrouterSupportsPromptCache` has always returned true for them. This
    // pins that the native recipe now produces an identical breakpoint shape
    // rather than a second, divergent one.
    //
    // The Anthropic-namespace marker rides along on both. It is inert off
    // Anthropic: the AI SDK routes `providerOptions` by provider key, so an
    // `anthropic` entry never reaches an OpenAI request body — the same
    // reason the shipped OpenRouter OpenAI route can carry it safely.
    const capture = async (model: string, env: Record<string, string>) => {
      let captured: any;
      __setGenerateTextTransportForTests(async (args: any) => {
        captured = args;
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        } as any;
      });
      configureGateway({ chat_model: model, env } as any);
      await chat({
        model,
        system: 'SYS',
        cacheSystem: true,
        messages: [{ role: 'user', content: 'hello' }],
      });
      return captured;
    };

    const viaOpenRouter = await capture('openrouter:openai/gpt-5.2', { OPENROUTER_API_KEY: 'fake' });
    const native = await capture('openai:gpt-4o-mini', { OPENAI_API_KEY: 'fake' });

    expect(native.system).toEqual(viaOpenRouter.system);
    expect(native.providerOptions?.anthropic).toEqual(viaOpenRouter.providerOptions?.anthropic);
    // Native OpenAI additionally carries its own routing hint, which is gated
    // on the recipe implementation and not on this flag.
    expect(native.providerOptions?.openai?.promptCacheKey).toBeString();
  });

  test('a configured cacheControl TTL override applies to every breakpoint, not just the call-level one', async () => {
    // Codex review finding: with three independently-hardcoded `{type:
    // 'ephemeral'}` markers, a `provider_chat_options.anthropic.cacheControl`
    // TTL override (e.g. `ttl: '1h'`) would only reach the call-level marker
    // via applyConfiguredChatProviderOptions()'s deep-merge — the system and
    // tool markers would stay implicit 5m, mixing TTLs across breakpoints in
    // the same request. Assert all three markers derive from ONE canonical
    // value instead.
    let captured: any;
    __setGenerateTextTransportForTests(async (args: any) => {
      captured = args;
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as any;
    });
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      provider_chat_options: {
        anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      },
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    await chat({
      model: 'anthropic:claude-sonnet-4-6',
      system: 'SYS',
      cacheSystem: true,
      tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: 'hello' }],
    });

    const expected = { type: 'ephemeral', ttl: '1h' };
    expect(captured.providerOptions?.anthropic?.cacheControl).toEqual(expected);
    expect((captured.system as any)?.providerOptions?.anthropic?.cacheControl).toEqual(expected);
    expect(captured.tools?.search?.providerOptions?.anthropic?.cacheControl).toEqual(expected);
  });
});

describe('OpenRouter prompt caching (takeover of PR #1988)', () => {
  beforeEach(() => {
    resetGateway();
    __setGenerateTextTransportForTests(null);
  });

  async function captureOpenRouterArgs(model: string, cacheSystem: boolean): Promise<any> {
    let captured: any;
    __setGenerateTextTransportForTests(async (args: any) => {
      captured = args;
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as any;
    });
    configureGateway({
      chat_model: model,
      env: { OPENROUTER_API_KEY: 'fake' },
    });
    await chat({
      model,
      system: 'stable system prompt',
      cacheSystem,
      messages: [{ role: 'user', content: 'hello' }],
    });
    return captured;
  }

  test('cacheSystem:true on an OpenRouter Claude route threads the private marker header to the compat fetch shim', async () => {
    const args = await captureOpenRouterArgs('openrouter:anthropic/claude-sonnet-4.6', true);
    expect(args.headers).toEqual({ [OPENROUTER_CACHE_HEADER]: '1' });
  });

  test('cacheSystem:false on an OpenRouter Claude route sends no marker header', async () => {
    const args = await captureOpenRouterArgs('openrouter:anthropic/claude-sonnet-4.6', false);
    expect(args.headers).toBeUndefined();
  });

  test('cacheSystem:true on an OpenRouter OpenAI route needs no marker (OR caches OpenAI automatically)', async () => {
    const args = await captureOpenRouterArgs('openrouter:openai/gpt-5.2', true);
    expect(args.headers).toBeUndefined();
  });

  test('cacheSystem:true on a non-cacheable OpenRouter route is silently ignored', async () => {
    // A family the predicate does not list, so useCache stays false.
    const args = await captureOpenRouterArgs('openrouter:google/gemini-3-flash-preview', true);
    expect(args.headers).toBeUndefined();
    // useCache is false → system stays a bare string.
    expect(args.system).toBe('stable system prompt');
  });

  test('a cacheable-but-implicit OpenRouter route gets the breakpoint without the rewrite header', async () => {
    // DeepSeek routes cache automatically: the marker rides along (inert off
    // Anthropic) but the fetch shim's rewrite header must NOT be set, since
    // only Anthropic Claude routes need the explicit cache_control block.
    const args = await captureOpenRouterArgs('openrouter:deepseek/deepseek-chat', true);
    expect(args.headers).toBeUndefined();
    expect(args.system).toEqual({
      role: 'system',
      content: 'stable system prompt',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  });
});
