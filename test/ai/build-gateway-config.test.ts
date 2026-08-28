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
import { KNOWN_CONFIG_KEYS, type GBrainConfig } from '../../src/core/config.ts';
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

  // #2662: voyage_api_key was accepted at the file plane (config.json) but
  // never folded into the gateway env, so daemons/launchd/MCP callers with
  // no process-env export silently failed multimodal embeds. Same fold
  // pattern as zeroentropy/openrouter above.
  test('voyage_api_key folds into gateway env as VOYAGE_API_KEY', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined }, async () => {
      const cfg = buildGatewayConfig({
        voyage_api_key: 'pa-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.VOYAGE_API_KEY).toBe('pa-config-plane');
    });
  });

  test('a real VOYAGE_API_KEY process.env value wins over the config-plane fallback', async () => {
    await withEnv({ VOYAGE_API_KEY: 'pa-env-plane' }, async () => {
      const cfg = buildGatewayConfig({
        voyage_api_key: 'pa-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.VOYAGE_API_KEY).toBe('pa-env-plane');
    });
  });

  // #3500: dashscope_api_key was accepted at the file plane but never folded,
  // so the dashscope/dashscope-rerank recipes (required: DASHSCOPE_API_KEY)
  // could only be keyed via a process-env export.
  test('dashscope_api_key folds into gateway env as DASHSCOPE_API_KEY', async () => {
    await withEnv({ DASHSCOPE_API_KEY: undefined }, async () => {
      const cfg = buildGatewayConfig({
        dashscope_api_key: 'sk-ds-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.DASHSCOPE_API_KEY).toBe('sk-ds-config-plane');
    });
  });

  test('a real DASHSCOPE_API_KEY process.env value wins over the config-plane fallback', async () => {
    await withEnv({ DASHSCOPE_API_KEY: 'sk-ds-env-plane' }, async () => {
      const cfg = buildGatewayConfig({
        dashscope_api_key: 'sk-ds-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.DASHSCOPE_API_KEY).toBe('sk-ds-env-plane');
    });
  });

  // Same seam for LiteLLM + Together, closed alongside litellm's chat
  // touchpoint (v0.42.61.0): once litellm became a full chat provider,
  // daemon/launchd/MCP contexts hit the same config-plane gap voyage did
  // (#2662). The fold lives in mergedProviderEnv (src/core/ai/provider-env.ts).
  test('litellm_api_key folds into gateway env as LITELLM_API_KEY', async () => {
    await withEnv({ LITELLM_API_KEY: undefined }, async () => {
      const cfg = buildGatewayConfig({
        litellm_api_key: 'sk-llm-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.LITELLM_API_KEY).toBe('sk-llm-config-plane');
    });
  });

  test('a real LITELLM_API_KEY process.env value wins over the config-plane fallback', async () => {
    await withEnv({ LITELLM_API_KEY: 'sk-llm-env-plane' }, async () => {
      const cfg = buildGatewayConfig({
        litellm_api_key: 'sk-llm-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.LITELLM_API_KEY).toBe('sk-llm-env-plane');
    });
  });

  test('together_api_key folds into gateway env as TOGETHER_API_KEY', async () => {
    await withEnv({ TOGETHER_API_KEY: undefined }, async () => {
      const cfg = buildGatewayConfig({
        together_api_key: 'sk-tg-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.TOGETHER_API_KEY).toBe('sk-tg-config-plane');
    });
  });

  test('a real TOGETHER_API_KEY process.env value wins over the config-plane fallback', async () => {
    await withEnv({ TOGETHER_API_KEY: 'sk-tg-env-plane' }, async () => {
      const cfg = buildGatewayConfig({
        together_api_key: 'sk-tg-config-plane',
      } as unknown as GBrainConfig);
      expect(cfg.env.TOGETHER_API_KEY).toBe('sk-tg-env-plane');
    });
  });

  // #3500: the google recipe reads GOOGLE_GENERATIVE_AI_API_KEY; before this
  // fold the ONLY configuration route was exporting that exact env name.
  test('google_api_key folds into gateway env as GOOGLE_GENERATIVE_AI_API_KEY', async () => {
    await withEnv(
      { GOOGLE_GENERATIVE_AI_API_KEY: undefined, GEMINI_API_KEY: undefined },
      async () => {
        const cfg = buildGatewayConfig({
          google_api_key: 'AIza-config-plane',
        } as unknown as GBrainConfig);
        expect(cfg.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('AIza-config-plane');
      },
    );
  });

  // Recurring-class guard: EVERY *_api_key field declared in
  // KNOWN_CONFIG_KEYS must reach the gateway env dict. Adding a new
  // provider key field to GBrainConfig without folding it in
  // buildGatewayConfig fails here — the #121/#2662/#3500 bug class.
  test('every KNOWN_CONFIG_KEYS *_api_key field reaches the gateway env', async () => {
    const keyFields = KNOWN_CONFIG_KEYS.filter((k) => k.endsWith('_api_key'));
    expect(keyFields.length).toBeGreaterThanOrEqual(7);
    for (const field of keyFields) {
      const sentinel = `sentinel-${field}`;
      // Clear the two env names the field could map to so config must win.
      await withEnv(
        {
          [field.replace(/_api_key$/, '').toUpperCase() + '_API_KEY']: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
          GEMINI_API_KEY: undefined,
        },
        async () => {
          const cfg = buildGatewayConfig({ [field]: sentinel } as unknown as GBrainConfig);
          expect(
            Object.values(cfg.env).includes(sentinel),
            `config field "${field}" never reaches the gateway env — add a fold in buildGatewayConfig`,
          ).toBe(true);
        },
      );
    }
  });
});

describe('buildGatewayConfig GEMINI_API_KEY alias (#3500)', () => {
  // GEMINI_API_KEY is the env name Google's own docs and SDKs use; the
  // recipe/gateway read GOOGLE_GENERATIVE_AI_API_KEY. Precedence:
  // env GOOGLE_GENERATIVE_AI_API_KEY > env GEMINI_API_KEY > config google_api_key.
  test('GEMINI_API_KEY aliases to GOOGLE_GENERATIVE_AI_API_KEY', async () => {
    await withEnv(
      { GOOGLE_GENERATIVE_AI_API_KEY: undefined, GEMINI_API_KEY: 'AIza-gemini-env' },
      async () => {
        const cfg = buildGatewayConfig(baseConfig);
        expect(cfg.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('AIza-gemini-env');
      },
    );
  });

  test('canonical GOOGLE_GENERATIVE_AI_API_KEY env wins over the GEMINI_API_KEY alias', async () => {
    await withEnv(
      { GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-canonical', GEMINI_API_KEY: 'AIza-alias' },
      async () => {
        const cfg = buildGatewayConfig(baseConfig);
        expect(cfg.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('AIza-canonical');
      },
    );
  });

  test('GEMINI_API_KEY (process env) wins over the config-plane google_api_key', async () => {
    await withEnv(
      { GOOGLE_GENERATIVE_AI_API_KEY: undefined, GEMINI_API_KEY: 'AIza-gemini-env' },
      async () => {
        const cfg = buildGatewayConfig({
          google_api_key: 'AIza-config-plane',
        } as unknown as GBrainConfig);
        expect(cfg.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('AIza-gemini-env');
      },
    );
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

describe('buildGatewayConfig OCR-model threading (#4107)', () => {
  // The config key was declared/env-merged/DB-merged in config.ts but never
  // picked into AIGatewayConfig, so generateOcrText() could not see it.
  test('embedding_image_ocr_model reaches the gateway config', () => {
    const cfg = buildGatewayConfig({
      embedding_image_ocr_model: 'deepseek:deepseek-v4-pro',
    } as unknown as GBrainConfig);
    expect(cfg.embedding_image_ocr_model).toBe('deepseek:deepseek-v4-pro');
  });

  test('absent embedding_image_ocr_model stays undefined (expansion fallback signal preserved)', () => {
    const cfg = buildGatewayConfig(baseConfig);
    expect(cfg.embedding_image_ocr_model).toBeUndefined();
  });
});

/**
 * Side-effect guard (v0.37.x): importing buildGatewayConfig from src/cli.ts
 * must NOT trigger the CLI's top-level main() and dump help to stdout. The
 * helper is exported specifically so test/agent/daemon consumers can call
 * it as a library — the import side effect was historically the loudest
 * source of test-runner noise. Wrap is in src/cli.ts: `if (import.meta.main)`
 * around the `main().catch(...)` invocation.
 */

import { spawnSync } from 'child_process';

describe('buildGatewayConfig import side effect guard', () => {
  /**
   * Spawn `bun run src/cli.ts --help` as a subprocess. Process-global stdout
   * capture avoids any contamination from the test runner's own TTY hooks.
   * The CLI dispatcher MUST print help when invoked as the entry point
   * (no side-effect regression). When main() accidentally fires during an
   * import, this help text is what ends up leaking into test output.
   */
  function runCliHelp(): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(
      'bun',
      ['run', 'src/cli.ts', '--help'],
      {
        cwd: import.meta.dir + '/../..',
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
    };
  }

  test('direct CLI entry --help still prints help to stdout (regression guard)', () => {
    const { stdout, status } = runCliHelp();
    expect(status).toBe(0);
    expect(stdout).toContain('gbrain');
    expect(stdout.toLowerCase()).toMatch(/usage|commands|search|init/);
  });

  test('importing buildGatewayConfig does NOT trigger main() (no help on stdout)', async () => {
    // The helper import at the top of this file is the unit under test — it
    // already ran by the time describe() executes. Re-importing here is
    // belt-and-suspenders: any future test that splits the suite would still
    // exercise the side-effect contract from a fresh module record.
    const mod = await import('../../src/cli.ts');
    expect(typeof mod.buildGatewayConfig).toBe('function');

    // Build a synthetic config and call it. Pre-fix behavior: importing the
    // module executed `main()` which read argv and called printHelp(). The
    // printHelp output landed on stdout during test bootstrap — observable
    // as a leading "gbrain" banner before the test runner's own output.
    // Post-fix: the import is silent; only the call below produces output,
    // and the helper itself writes nothing.
    const cfg = mod.buildGatewayConfig({} as unknown as GBrainConfig);
    expect(cfg).toBeDefined();
  });

  test('subprocess importing buildGatewayConfig sees no CLI help on stdout', () => {
    // Independent subprocess so the test runner's own process state cannot
    // mask a leak. The spawned bun evaluates the same import the test file
    // does, then exits. Pre-fix: stdout includes the help banner (and the
    // process would exit 0 because main() returns normally after printHelp()).
    // Post-fix: stdout is empty; only the bun runtime header / warnings may
    // appear on stderr.
    const inline = `
      import { buildGatewayConfig } from './src/cli.ts';
      const cfg = buildGatewayConfig({});
      // Touch the result so the engine does not dead-code-eliminate the call.
      if (!cfg) process.exit(2);
    `;
    const result = spawnSync(
      'bun',
      ['--eval', inline],
      {
        cwd: import.meta.dir + '/../..',
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/usage|commands available|gbrain v?\\d/);
  });
});
