/**
 * mergedProviderEnv — the canonical provider-key/env fold (one mapping shared
 * by buildGatewayConfig, detectCapabilities, and key-aware model resolution).
 * Pins the unification deltas: Azure fields present (the old capability copy
 * omitted them), GEMINI alias present (both copies had it), #1249 empty-drop.
 */
import { describe, test, expect } from 'bun:test';
import { mergedProviderEnv } from '../src/core/ai/provider-env.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const cfg = (partial: Partial<GBrainConfig>): GBrainConfig =>
  ({ engine: 'pglite', ...partial }) as GBrainConfig;

describe('mergedProviderEnv', () => {
  test('folds every file-plane key incl. the Azure fields (unification delta)', () => {
    const env = mergedProviderEnv(cfg({
      openai_api_key: 'sk-o', anthropic_api_key: 'sk-a', voyage_api_key: 'pa-v',
      zeroentropy_api_key: 'ze', openrouter_api_key: 'or', dashscope_api_key: 'ds',
      google_api_key: 'gg',
      azure_openai_endpoint: 'https://x.openai.azure.com',
      azure_openai_deployment: 'gpt-5',
      azure_openai_use_entra: '1',
    }), {});
    expect(env.OPENAI_API_KEY).toBe('sk-o');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-a');
    expect(env.VOYAGE_API_KEY).toBe('pa-v');
    expect(env.ZEROENTROPY_API_KEY).toBe('ze');
    expect(env.OPENROUTER_API_KEY).toBe('or');
    expect(env.DASHSCOPE_API_KEY).toBe('ds');
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('gg');
    expect(env.AZURE_OPENAI_ENDPOINT).toBe('https://x.openai.azure.com');
    expect(env.AZURE_OPENAI_DEPLOYMENT).toBe('gpt-5');
    expect(env.AZURE_OPENAI_USE_ENTRA).toBe('1');
  });

  test('env wins over config ONLY for real values; empty strings dropped (#1249)', () => {
    const env = mergedProviderEnv(
      cfg({ anthropic_api_key: 'sk-config' }),
      { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'sk-env', UNRELATED: undefined },
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-config'); // '' must not clobber
    expect(env.OPENAI_API_KEY).toBe('sk-env');
    expect('UNRELATED' in env).toBe(false);
  });

  test('GEMINI_API_KEY alias: canonical env name > alias > config fallback', () => {
    expect(mergedProviderEnv(null, { GEMINI_API_KEY: 'g-alias' }).GOOGLE_GENERATIVE_AI_API_KEY).toBe('g-alias');
    expect(mergedProviderEnv(null, {
      GEMINI_API_KEY: 'g-alias', GOOGLE_GENERATIVE_AI_API_KEY: 'g-canonical',
    }).GOOGLE_GENERATIVE_AI_API_KEY).toBe('g-canonical');
    expect(mergedProviderEnv(cfg({ google_api_key: 'g-config' }), { GEMINI_API_KEY: 'g-alias' })
      .GOOGLE_GENERATIVE_AI_API_KEY).toBe('g-alias'); // alias is still process-env: beats config
  });

  test('buildGatewayConfig consumes the shared fold (no drift possible)', async () => {
    // The gateway env must carry the same fold — assert a config-plane key
    // reaches the recipes' env name through buildGatewayConfig. Pin the real
    // env var (dev shells export it; env legitimately wins over config).
    await withEnv({ VOYAGE_API_KEY: undefined }, () => {
      const gw = buildGatewayConfig(cfg({ voyage_api_key: 'pa-through-gateway' }));
      expect(gw.env?.VOYAGE_API_KEY).toBe('pa-through-gateway');
    });
  });
});
