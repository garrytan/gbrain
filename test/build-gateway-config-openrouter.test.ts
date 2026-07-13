import { describe, expect, test } from 'bun:test';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import type { GBrainConfig } from '../src/core/config.ts';

describe('buildGatewayConfig openrouter file-plane config', () => {
  test('maps openrouter_api_key into gateway env and preserves provider base URLs', () => {
    const cfg: GBrainConfig = {
      engine: 'pglite',
      openrouter_api_key: 'unused-local-proxy-key',
      provider_base_urls: {
        openrouter: 'http://127.0.0.1:8787/v1',
      },
    };

    const gateway = buildGatewayConfig(cfg);

    expect(gateway.env.OPENROUTER_API_KEY).toBe('unused-local-proxy-key');
    expect(gateway.base_urls?.openrouter).toBe('http://127.0.0.1:8787/v1');
  });
});
