/**
 * Regression guard for Anthropic prompt-cache breakpoint PLACEMENT.
 *
 * The bug this pins: `@ai-sdk/anthropic` reads `cache_control` ONLY from each
 * system message's / tool's own `providerOptions` — never from the top-level
 * `generateText({ providerOptions })`. And `ai` core converts a bare `system:`
 * STRING into `{ role:'system', content }` with NO `providerOptions`. So the
 * pre-fix gateway (string `system` + top-level `providerOptions.anthropic.
 * cacheControl`) wrote ZERO breakpoints — a silent no-op: every
 * `cacheSystem:true` caller (enrich, page-summary, skillopt, gateway toolLoop)
 * paid full price while telemetry read 0 cache tokens.
 *
 * `buildChatCacheArgs` places the markers where the provider actually reads
 * them. These cases would FAIL on the old code path (string system, no per-
 * message/per-tool marker) and pass now. Shapes verified against AI SDK 6.0.174
 * / @ai-sdk/anthropic 3.0.74, whose SystemModelMessage docs say: "if you need
 * to pass additional provider options (e.g. for caching), a SystemModelMessage".
 */
import { describe, test, expect } from 'bun:test';
import {
  buildChatCacheArgs,
  buildOpenAIProviderOptions,
  openAIPromptCacheKey,
  type ChatToolDef,
} from '../src/core/ai/gateway.ts';

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

const TOOLS: ChatToolDef[] = [
  { name: 'search', description: 'search the brain', inputSchema: { type: 'object' } },
  { name: 'put_page', description: 'write a page', inputSchema: { type: 'object' } },
];

describe('buildChatCacheArgs — Anthropic cache breakpoint placement', () => {
  test('caching ON: system is a SystemModelMessage carrying cacheControl (NOT a bare string)', () => {
    const { system } = buildChatCacheArgs({ useCache: true, system: 'SYS', tools: [] });
    // The exact regression: a bare string here means the marker is dropped.
    expect(typeof system).not.toBe('string');
    expect(system).toEqual({
      role: 'system',
      content: 'SYS',
      providerOptions: EPHEMERAL,
    });
  });

  test('caching ON: ONLY the last tool def carries the cache breakpoint', () => {
    const { tools } = buildChatCacheArgs({ useCache: true, system: 'SYS', tools: TOOLS });
    // Anthropic caches the whole prefix up to the marked block, so marking the
    // final tool covers all tool defs — earlier ones must stay unmarked.
    expect(tools.search.providerOptions).toBeUndefined();
    expect(tools.put_page.providerOptions).toEqual(EPHEMERAL);
  });

  test('caching ON without a system prompt: tools still cached, system stays undefined', () => {
    const { system, tools } = buildChatCacheArgs({ useCache: true, system: undefined, tools: TOOLS });
    expect(system).toBeUndefined();
    expect(tools.put_page.providerOptions).toEqual(EPHEMERAL);
  });

  test('caching OFF: system is the bare string and NO tool carries a breakpoint', () => {
    const { system, tools } = buildChatCacheArgs({ useCache: false, system: 'SYS', tools: TOOLS });
    expect(system).toBe('SYS');
    expect(tools.search.providerOptions).toBeUndefined();
    expect(tools.put_page.providerOptions).toBeUndefined();
  });

  test('tool defs keep their schema + description regardless of caching', () => {
    const { tools } = buildChatCacheArgs({ useCache: true, system: 'SYS', tools: TOOLS });
    expect(tools.search.description).toBe('search the brain');
    // jsonSchema() wraps the raw schema; the marker must not clobber inputSchema.
    expect(tools.put_page.inputSchema).toBeDefined();
    expect(tools.put_page.providerOptions).toEqual(EPHEMERAL);
  });
});

describe('openAIPromptCacheKey — prompt_cache_key routing hint', () => {
  test('same system + same tools → identical stable key (sticky routing)', () => {
    const a = openAIPromptCacheKey({ system: 'SYS', toolNames: ['search', 'put_page'] });
    const b = openAIPromptCacheKey({ system: 'SYS', toolNames: ['put_page', 'search'] });
    expect(a).toBe(b); // tool ORDER must not change the key
    expect(a).toMatch(/^gbrain:[0-9a-f]{32}$/);
  });

  test('different system → different key', () => {
    const a = openAIPromptCacheKey({ system: 'SYS A', toolNames: [] });
    const b = openAIPromptCacheKey({ system: 'SYS B', toolNames: [] });
    expect(a).not.toBe(b);
  });

  test('different tool set → different key', () => {
    const a = openAIPromptCacheKey({ system: 'SYS', toolNames: ['search'] });
    const b = openAIPromptCacheKey({ system: 'SYS', toolNames: ['search', 'put_page'] });
    expect(a).not.toBe(b);
  });

  test('explicit key overrides the derived hash', () => {
    expect(openAIPromptCacheKey({ system: 'SYS', explicit: 'session-42' })).toBe('session-42');
  });

  test('no system and no explicit key → undefined (do not pin one-off requests)', () => {
    expect(openAIPromptCacheKey({ system: undefined, toolNames: ['search'] })).toBeUndefined();
  });
});

describe('buildOpenAIProviderOptions — recipe gate (the chat() wiring)', () => {
  test('native-openai with a system prompt → { openai: { promptCacheKey } }', () => {
    const opts = buildOpenAIProviderOptions({ implementation: 'native-openai', system: 'SYS', toolNames: ['search'] });
    expect(opts?.openai?.promptCacheKey).toMatch(/^gbrain:[0-9a-f]{32}$/);
  });

  test('native-openai with an explicit key passes it through', () => {
    const opts = buildOpenAIProviderOptions({ implementation: 'native-openai', system: 'SYS', explicit: 'session-42' });
    expect(opts).toEqual({ openai: { promptCacheKey: 'session-42' } });
  });

  test('native-anthropic → undefined (never sends promptCacheKey to Anthropic)', () => {
    expect(buildOpenAIProviderOptions({ implementation: 'native-anthropic', system: 'SYS' })).toBeUndefined();
  });

  test('openai-compatible (litellm/azure) → undefined (provider ignores providerOptions.openai)', () => {
    expect(buildOpenAIProviderOptions({ implementation: 'openai-compatible', system: 'SYS' })).toBeUndefined();
  });

  test('native-openai but nothing stable to key on → undefined (no empty options object)', () => {
    expect(buildOpenAIProviderOptions({ implementation: 'native-openai', system: undefined })).toBeUndefined();
  });
});
