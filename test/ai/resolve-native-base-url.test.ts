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

  test('config-plane base_urls reaches native providers, same normalization', () => {
    // provider_base_urls.openai / .anthropic flow into cfg.base_urls via
    // buildGatewayConfig; before the fallback, native providers ignored the
    // config plane entirely (env-only).
    const cfg = { env: {}, base_urls: { openai: 'https://proxy.example' } } as unknown as AIGatewayConfig;
    expect(resolveNativeBaseUrl('openai', cfg)).toBe('https://proxy.example/v1');
    expect(resolveNativeBaseUrl('anthropic', cfg)).toBeUndefined();
  });

  test('config-plane base_urls wins over the env var (matches buildGatewayConfig contract)', () => {
    const cfg = {
      env: { OPENAI_BASE_URL: 'https://env.example' },
      base_urls: { openai: 'https://config.example/v1' },
    } as unknown as AIGatewayConfig;
    expect(resolveNativeBaseUrl('openai', cfg)).toBe('https://config.example/v1');
  });

  test('anthropic reads config-plane base_urls with the same /v1 normalization', () => {
    const cfg = { env: {}, base_urls: { anthropic: 'https://a.example' } } as unknown as AIGatewayConfig;
    expect(resolveNativeBaseUrl('anthropic', cfg)).toBe('https://a.example/v1');
    expect(resolveNativeBaseUrl('openai', cfg)).toBeUndefined();
  });

  test('config-plane native override must be https or loopback (DB-plane redirection guard)', () => {
    // provider_base_urls merges DB-plane rows; a plaintext non-local entry
    // would redirect key-carrying native traffic. Env plane keeps its
    // historical behavior (operator-controlled, per-machine).
    const bad = { env: {}, base_urls: { openai: 'http://evil.example' } } as unknown as AIGatewayConfig;
    expect(() => resolveNativeBaseUrl('openai', bad)).toThrow(/must be https/);
    const local = { env: {}, base_urls: { openai: 'http://localhost:8080' } } as unknown as AIGatewayConfig;
    expect(resolveNativeBaseUrl('openai', local)).toBe('http://localhost:8080/v1');
    const envHttp = { env: { OPENAI_BASE_URL: 'http://proxy.internal' }, base_urls: {} } as unknown as AIGatewayConfig;
    expect(resolveNativeBaseUrl('openai', envHttp)).toBe('http://proxy.internal/v1');
  });

  test('present-but-empty config entry fails loud instead of silently masking the env var', () => {
    // An empty `provider_base_urls.openai` would otherwise mask a set
    // OPENAI_BASE_URL and return undefined — routing traffic (key attached)
    // straight to the provider past an env-mandated egress proxy, silently.
    // The openai-compat plane throws on the same shape ("requires a base
    // URL"); the native plane mirrors that loud contract.
    const cfg = {
      env: { OPENAI_BASE_URL: 'https://env.example' },
      base_urls: { openai: '' },
    } as unknown as AIGatewayConfig;
    expect(() => resolveNativeBaseUrl('openai', cfg)).toThrow(/set but empty/);
    // Absent entry (undefined) still falls through to the env var.
    const cfg2 = { env: { OPENAI_BASE_URL: 'https://env.example' }, base_urls: {} } as unknown as AIGatewayConfig;
    expect(resolveNativeBaseUrl('openai', cfg2)).toBe('https://env.example/v1');
  });
});
