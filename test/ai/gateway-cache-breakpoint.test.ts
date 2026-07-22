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

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  chat,
  configureGateway,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';

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

  test('cacheSystem:true on a non-Anthropic model is silently ignored (supports_prompt_cache=false)', async () => {
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
      chat_model: 'openai:gpt-4o-mini',
      env: { OPENAI_API_KEY: 'fake' },
    });
    await chat({
      model: 'openai:gpt-4o-mini',
      system: 'SYS',
      cacheSystem: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    // Still a bare string — the recipe doesn't support prompt caching, so
    // useCache is false regardless of the caller's request.
    expect(captured.system).toBe('SYS');
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
