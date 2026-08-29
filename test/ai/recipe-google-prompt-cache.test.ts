/**
 * Google/Gemini prompt-cache capability is a per-model predicate, not a flat
 * boolean: Gemini's implicit caching (the only kind the gateway can benefit
 * from — it sends no cache directives on the Google path) is default-on for
 * 2.5 and newer, and absent on 1.5/2.0.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { googleSupportsPromptCache } from '../../src/core/ai/recipes/google.ts';
import { getProviderCapabilities } from '../../src/core/ai/capabilities.ts';
import {
  chat,
  configureGateway,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';

afterAll(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
});

describe('recipe: google prompt cache', () => {
  test('chat touchpoint wires the predicate, not a boolean', () => {
    const chat = getRecipe('google')!.touchpoints.chat!;
    expect(chat.supports_prompt_cache).toBe(googleSupportsPromptCache);
  });

  test('2.5 and newer cache; older families and non-Gemini ids do not', () => {
    expect(googleSupportsPromptCache('gemini-2.5-flash')).toBe(true);
    expect(googleSupportsPromptCache('gemini-2.5-pro')).toBe(true);
    expect(googleSupportsPromptCache('gemini-3-flash-preview')).toBe(true);
    // Version digits trail the family name on this one — position varies.
    expect(googleSupportsPromptCache('gemini-3.6-flash')).toBe(true);
    // UNVERSIONED `-latest` aliases carry no digits but always point at
    // current models.
    expect(googleSupportsPromptCache('gemini-flash-latest')).toBe(true);
    expect(googleSupportsPromptCache('gemini-pro-latest')).toBe(true);
    // VERSIONED `-latest` aliases are judged by their version, not the alias:
    // the real gemini-1.5-*-latest ids cache only via the explicit API
    // (adversarial-review fix — the alias shortcut used to run first).
    expect(googleSupportsPromptCache('gemini-1.5-pro-latest')).toBe(false);
    expect(googleSupportsPromptCache('gemini-1.5-flash-latest')).toBe(false);
    expect(googleSupportsPromptCache('gemini-2.5-pro-latest')).toBe(true);

    expect(googleSupportsPromptCache('gemini-2.0-flash')).toBe(false);
    expect(googleSupportsPromptCache('gemini-2.0-flash-exp')).toBe(false);
    expect(googleSupportsPromptCache('gemini-1.5-pro')).toBe(false);
    expect(googleSupportsPromptCache('gemini-embedding-001')).toBe(false);
    expect(googleSupportsPromptCache('gemma-3-27b-it')).toBe(false);
    // Date/experiment suffixes are NOT versions: parseFloat('1206') >= 2.5
    // must never promise a discount a 1.x-era experimental model lacked.
    expect(googleSupportsPromptCache('gemini-exp-1206')).toBe(false);
    expect(googleSupportsPromptCache('gemini-exp-0827')).toBe(false);
  });

  test('off-list passthrough ids resolve through the capability layer', () => {
    // The recipe's `models` list is not enforced for native Google ids at the
    // config plane, so a newer Gemini the list has not caught up to still has
    // to be classified correctly.
    expect(getProviderCapabilities('google:gemini-2.5-flash').supportsPromptCaching).toBe(true);
    expect(getProviderCapabilities('google:gemini-1.5-pro').supportsPromptCaching).toBe(false);
  });

  test('cacheSystem on a caching Gemini injects ONLY anthropic-namespaced markers — nothing the google adapter acts on', async () => {
    // The flip is functionally safe because Gemini caching is implicit: the
    // gateway must not start sending Google-visible cache directives just
    // because supports_prompt_cache is now true. Everything cache-shaped in
    // the transport args has to stay in the `anthropic` namespace (which
    // @ai-sdk/google ignores at every level) — no `providerOptions.google`
    // cache keys, no cachedContent field. If this test starts failing, a
    // change made the predicate drive REAL request mutation on the Google
    // path; that needs the cache-MODE design (implicit vs explicit), not a
    // silent flip.
    resetGateway();
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
      chat_model: 'google:gemini-2.5-flash',
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' },
    });
    await chat({
      model: 'google:gemini-2.5-flash',
      system: 'stable system prompt',
      messages: [{ role: 'user', content: 'hello' }],
      cacheSystem: true,
      tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} } }],
    });
    __setGenerateTextTransportForTests(null);
    resetGateway();

    // Cache markers exist (shared code path) but only under `anthropic`.
    const po = captured.providerOptions ?? {};
    const googleKeys = Object.keys(po.google ?? {});
    expect(googleKeys.filter(k => /cache/i.test(k))).toEqual([]);
    expect(JSON.stringify(po.google ?? {})).not.toMatch(/cache/i);
    // System block marker stays anthropic-namespaced.
    if (typeof captured.system === 'object' && captured.system?.providerOptions) {
      expect(Object.keys(captured.system.providerOptions)).toEqual(['anthropic']);
    }
    // Tool-def marker stays anthropic-namespaced.
    for (const tool of Object.values<any>(captured.tools ?? {})) {
      if (tool?.providerOptions) {
        expect(Object.keys(tool.providerOptions)).toEqual(['anthropic']);
      }
    }
    // No Gemini explicit-cache surface is touched.
    expect(captured.cachedContent).toBeUndefined();
  });
});
