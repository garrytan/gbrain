/**
 * buildGatewayConfig env-baseURL passthrough sweep (v0.37.2.0).
 *
 * Mops up pre-existing untested drift: every `_BASE_URL` env var the CLI
 * reads (LLAMA_SERVER, OLLAMA, LMSTUDIO, LITELLM, OPENROUTER) was previously
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

  test('provider_chat_options passes through unchanged', async () => {
    await withEnv(envFor(null), async () => {
      const options = {
        anthropic: { thinking: { type: 'disabled' } },
        'anthropic:claude-sonnet-4-6': { thinking: { budget_tokens: 256 } },
      };
      const cfg = buildGatewayConfig({
        provider_chat_options: options,
      } as unknown as GBrainConfig);
      expect(cfg.provider_chat_options).toBe(options);
    });
  });
});

describe('buildGatewayConfig config-plane API-key folding', () => {
  test('openrouter_api_key folds into gateway env as OPENROUTER_API_KEY', async () => {
    await withEnv({ OPENROUTER_API_KEY: undefined }, async () => {
      const cfg = buildGatewayConfig({
        openrouter_api_key: 'sk-or-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.OPENROUTER_API_KEY).toBe('sk-or-config-plane');
    });
  });

  test('a real OPENROUTER_API_KEY process.env value wins over the config-plane fallback', async () => {
    await withEnv({ OPENROUTER_API_KEY: 'sk-or-env-plane' }, async () => {
      const cfg = buildGatewayConfig({
        openrouter_api_key: 'sk-or-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.OPENROUTER_API_KEY).toBe('sk-or-env-plane');
    });
  });
});

describe('buildGatewayConfig env empty-string clobber guard (#1249)', () => {
  test('an empty-string process.env value does NOT clobber a valid config-plane key', async () => {
    // Claude Code injects ANTHROPIC_API_KEY='' to neuter subprocess LLM calls.
    await withEnv({ ANTHROPIC_API_KEY: '' }, async () => {
      const cfg = buildGatewayConfig({
        anthropic_api_key: 'sk-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.ANTHROPIC_API_KEY).toBe('sk-config-plane');
    });
  });

  test('a real process.env value still wins over the config-plane fallback', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-env-plane' }, async () => {
      const cfg = buildGatewayConfig({
        anthropic_api_key: 'sk-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.ANTHROPIC_API_KEY).toBe('sk-env-plane');
    });
  });

  test("legitimate falsy-but-present values ('0' / 'false') are preserved, not dropped", async () => {
    await withEnv(
      { GBRAIN_TEST_ZERO_VAL: '0', GBRAIN_TEST_FALSE_VAL: 'false' },
      async () => {
        const cfg = buildGatewayConfig(baseConfig);
        expect(cfg.env.GBRAIN_TEST_ZERO_VAL).toBe('0');
        expect(cfg.env.GBRAIN_TEST_FALSE_VAL).toBe('false');
      },
    );
  });
});
