/**
 * buildGatewayConfig env-baseURL passthrough sweep (v0.37.2.0).
 *
 * Mops up pre-existing untested drift: every `_BASE_URL` env var the CLI
 * reads (LLAMA_SERVER, OLLAMA, LMSTUDIO, LITELLM, OPENROUTER, CUSTOM_OPENAI)
 * was previously
 * uncovered by unit tests. The helper was file-local so the test surface
 * didn't exist; v0.37.2.0 exports it for the OR passthrough plus the four
 * legacy passthroughs by parameterized sweep.
 *
 * Behavior contract:
 *   - When the env var is set, buildGatewayConfig(c).base_urls[recipeId] === envValue.
 *   - When the env var is unset, base_urls[recipeId] is undefined (no spurious key).
 *   - Caller-provided cfg.provider_base_urls overrides the env value.
 *
 * Env-mutation discipline: every env mutation routes through `withEnv()` from
 * `test/helpers/with-env.ts`. Process-global env mutations would leak across
 * files in the same shard. `withEnv` save/restore via try/finally is the
 * canonical pattern (enforced by scripts/check-test-isolation.sh).
 */

import { describe, expect, test } from 'bun:test';
import { buildGatewayConfig } from '../../src/cli.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { withEnv } from '../helpers/with-env.ts';

const PASSTHROUGHS: Array<{ envVar: string; recipeId: string }> = [
  { envVar: 'LLAMA_SERVER_BASE_URL', recipeId: 'llama-server' },
  { envVar: 'OLLAMA_BASE_URL', recipeId: 'ollama' },
  { envVar: 'LMSTUDIO_BASE_URL', recipeId: 'lmstudio' },
  { envVar: 'LITELLM_BASE_URL', recipeId: 'litellm' },
  { envVar: 'OPENROUTER_BASE_URL', recipeId: 'openrouter' },
  { envVar: 'CUSTOM_OPENAI_BASE_URL', recipeId: 'custom-openai' },
];

const TEST_VALUE = 'http://proxy.example.test/v1';

const baseConfig: GBrainConfig = {} as unknown as GBrainConfig;

/**
 * Build an env-override object that clears every passthrough and sets one.
 * Other tests in the same shard may have set these; clearing all first ensures
 * the test asserts on a clean slate without manual saveEnv/restoreEnv bookkeeping.
 */
function envFor(target: { envVar: string } | null): Record<string, string | undefined> {
  const overrides: Record<string, string | undefined> = {};
  for (const { envVar } of PASSTHROUGHS) {
    overrides[envVar] = target?.envVar === envVar ? TEST_VALUE : undefined;
  }
  return overrides;
}

describe('buildGatewayConfig env-baseURL passthrough', () => {
  for (const passthrough of PASSTHROUGHS) {
    test(`${passthrough.envVar} flows through to base_urls.${passthrough.recipeId}`, async () => {
      await withEnv(envFor(passthrough), async () => {
        const cfg = buildGatewayConfig(baseConfig);
        expect(
          cfg.base_urls?.[passthrough.recipeId],
          `${passthrough.envVar} → base_urls.${passthrough.recipeId}`,
        ).toBe(TEST_VALUE);
      });
    });
  }

  test('unset env vars do NOT populate base_urls keys', async () => {
    await withEnv(envFor(null), async () => {
      const cfg = buildGatewayConfig(baseConfig);
      for (const { recipeId } of PASSTHROUGHS) {
        expect(
          cfg.base_urls?.[recipeId],
          `${recipeId} key should be absent when env unset`,
        ).toBeUndefined();
      }
    });
  });

  test('caller-provided provider_base_urls override env (config wins)', async () => {
    await withEnv(
      { ...envFor(null), OPENROUTER_BASE_URL: 'http://env.example/v1' },
      async () => {
        const cfg = buildGatewayConfig({
          provider_base_urls: { openrouter: 'http://config.example/v1' },
        } as unknown as GBrainConfig);
        expect(cfg.base_urls?.openrouter).toBe('http://config.example/v1');
      },
    );
  });

  test('custom provider config forwards its optional key and Base URL', async () => {
    await withEnv(envFor(null), async () => {
      const cfg = buildGatewayConfig({
        custom_openai_api_key: 'local-key',
        provider_base_urls: { 'custom-openai': 'http://127.0.0.1:8000/v1' },
      } as unknown as GBrainConfig);
      expect(cfg.env.CUSTOM_OPENAI_API_KEY).toBe('local-key');
      expect(cfg.base_urls?.['custom-openai']).toBe('http://127.0.0.1:8000/v1');
    });
  });

  test('forwards per-touchpoint provider Base URLs without changing the legacy fallback', async () => {
    await withEnv(envFor(null), async () => {
      const cfg = buildGatewayConfig({
        provider_base_urls: { 'custom-openai': 'http://127.0.0.1:8000/v1' },
        provider_touchpoint_base_urls: {
          'custom-openai': {
            chat: 'http://127.0.0.1:8001/v1',
            embedding: 'http://127.0.0.1:8002/v1',
          },
        },
      } as unknown as GBrainConfig);
      expect(cfg.base_urls?.['custom-openai']).toBe('http://127.0.0.1:8000/v1');
      expect(cfg.touchpoint_base_urls?.['custom-openai']).toEqual({
        chat: 'http://127.0.0.1:8001/v1',
        embedding: 'http://127.0.0.1:8002/v1',
      });
    });
  });

  test('forwards per-touchpoint provider API keys without changing the legacy fallback', async () => {
    await withEnv(envFor(null), async () => {
      const cfg = buildGatewayConfig({
        custom_openai_api_key: 'shared-key',
        provider_touchpoint_api_keys: {
          'custom-openai': {
            chat: 'chat-key',
            embedding: 'embedding-key',
          },
        },
      } as unknown as GBrainConfig);
      expect(cfg.env.CUSTOM_OPENAI_API_KEY).toBe('shared-key');
      expect(cfg.touchpoint_api_keys?.['custom-openai']).toEqual({
        chat: 'chat-key',
        embedding: 'embedding-key',
      });
    });
  });
});
