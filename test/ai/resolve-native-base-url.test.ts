/**
 * resolveNativeBaseUrl unit tests (#1250).
 *
 * Native providers (anthropic/openai) are instantiated as create<Provider>({ apiKey })
 * with no explicit baseURL, so the AI SDK reads <PROVIDER>_BASE_URL verbatim. A bare
 * host (Claude Code injects ANTHROPIC_BASE_URL=https://api.anthropic.com with no /v1)
 * makes the SDK POST <base>/messages → 404. resolveNativeBaseUrl normalizes a configured
 * base URL to carry /v1, and returns undefined when unset so the SDK default is preserved.
 *
 * Pure function over cfg.env — no process.env mutation, so no withEnv() needed.
 */

import { describe, expect, test } from 'bun:test';
import { resolveNativeBaseUrl } from '../../src/core/ai/gateway.ts';
import type { AIGatewayConfig } from '../../src/core/ai/types.ts';

function cfgWith(env: Record<string, string | undefined>): AIGatewayConfig {
  return { env } as unknown as AIGatewayConfig;
}

describe('resolveNativeBaseUrl (#1250)', () => {
  test('anthropic: bare host gets /v1 appended', () => {
    expect(
      resolveNativeBaseUrl('anthropic', cfgWith({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })),
    ).toBe('https://api.anthropic.com/v1');
  });

  test('anthropic: already-/v1 host is unchanged', () => {
    expect(
      resolveNativeBaseUrl('anthropic', cfgWith({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' })),
    ).toBe('https://api.anthropic.com/v1');
  });

  test('anthropic: trailing slashes are normalized', () => {
    expect(
      resolveNativeBaseUrl('anthropic', cfgWith({ ANTHROPIC_BASE_URL: 'https://proxy.example/' })),
    ).toBe('https://proxy.example/v1');
    expect(
      resolveNativeBaseUrl('anthropic', cfgWith({ ANTHROPIC_BASE_URL: 'https://proxy.example/v1/' })),
    ).toBe('https://proxy.example/v1');
  });

  test('anthropic: unset / empty → undefined so the SDK default is preserved [REGRESSION]', () => {
    expect(resolveNativeBaseUrl('anthropic', cfgWith({}))).toBeUndefined();
    expect(resolveNativeBaseUrl('anthropic', cfgWith({ ANTHROPIC_BASE_URL: '' }))).toBeUndefined();
    expect(resolveNativeBaseUrl('anthropic', cfgWith({ ANTHROPIC_BASE_URL: '   ' }))).toBeUndefined();
  });

  test('openai: reads OPENAI_BASE_URL with the same normalization', () => {
    expect(
      resolveNativeBaseUrl('openai', cfgWith({ OPENAI_BASE_URL: 'https://api.openai.com' })),
    ).toBe('https://api.openai.com/v1');
    expect(
      resolveNativeBaseUrl('openai', cfgWith({ OPENAI_BASE_URL: 'https://api.openai.com/v1' })),
    ).toBe('https://api.openai.com/v1');
    expect(resolveNativeBaseUrl('openai', cfgWith({}))).toBeUndefined();
  });

  test('each provider only reads its own env var', () => {
    expect(resolveNativeBaseUrl('openai', cfgWith({ ANTHROPIC_BASE_URL: 'https://x' }))).toBeUndefined();
    expect(resolveNativeBaseUrl('anthropic', cfgWith({ OPENAI_BASE_URL: 'https://x' }))).toBeUndefined();
  });
});
