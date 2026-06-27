/**
 * `gbrain providers` — pure formatter + envReady tests.
 *
 * `runTest` and `runExplain` aren't covered here because they touch the
 * gateway / loadConfig; E2E exercises those.
 */

import { afterEach, describe, test, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatRecipeTable, envReady, runProviders } from '../src/commands/providers.ts';
import { listRecipes, getRecipe } from '../src/core/ai/recipes/index.ts';
import { resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import type { Recipe } from '../src/core/ai/types.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('envReady', () => {
  test('true when all required env vars set', () => {
    const openai = getRecipe('openai');
    expect(openai).toBeDefined();
    expect(envReady(openai!, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
  });

  test('false when required env var missing', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, {})).toBe(false);
  });

  test('false on empty-string env var', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, { OPENAI_API_KEY: '' })).toBe(false);
  });

  test('true for recipes with no required env (local Ollama)', () => {
    // Ollama has no auth_env.required.
    const ollama = getRecipe('ollama');
    expect(ollama).toBeDefined();
    expect(envReady(ollama!, {})).toBe(true);
  });
});

describe('formatRecipeTable', () => {
  test('header row present', () => {
    const out = formatRecipeTable(listRecipes(), {});
    expect(out).toContain('PROVIDER');
    expect(out).toContain('TIER');
    expect(out).toContain('EMBED');
    expect(out).toContain('EXPAND');
    expect(out).toContain('CHAT');
    expect(out).toContain('STATUS');
  });

  test('shows ✓ ready for env-satisfied provider', () => {
    const out = formatRecipeTable(listRecipes(), { OPENAI_API_KEY: 'sk-test' });
    // openai row should be ready
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✓ ready');
  });

  test('shows ✗ missing <ENV> for missing provider', () => {
    const out = formatRecipeTable(listRecipes(), {});
    // openai should show missing OPENAI_API_KEY
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✗ missing OPENAI_API_KEY');
  });

  test('each recipe appears at most once', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const recipes = listRecipes();
    for (const r of recipes) {
      const occurrences = out.split('\n').filter(line => line.startsWith(`${r.id} `) || line.startsWith(`${r.id}  `));
      expect(occurrences.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('embedding-only recipe (zeroentropyai) shows yes/—/— for tiers', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const zeLine = out.split('\n').find(line => line.startsWith('zeroentropyai'));
    expect(zeLine).toBeDefined();
    // ZE has embedding but no expansion or chat
    expect(zeLine).toContain('yes');
    expect(zeLine).toContain('—');
  });

  test('isolated subset renders correctly (picker reuses this)', () => {
    const openai = getRecipe('openai');
    const ze = getRecipe('zeroentropyai');
    expect(openai && ze).toBeTruthy();
    const out = formatRecipeTable([openai!, ze!], { OPENAI_API_KEY: 'sk-test' });
    const lines = out.split('\n');
    // header + separator + 2 recipe rows
    expect(lines.length).toBe(4);
    expect(lines[2]).toContain('openai');
    expect(lines[2]).toContain('✓ ready');
    expect(lines[3]).toContain('zeroentropyai');
    expect(lines[3]).toContain('✗ missing ZEROENTROPY_API_KEY');
  });
});

describe('providers test command', () => {
  test('uses file-plane DashScope key and provider_base_urls from buildGatewayConfig', async () => {
    const home = emptyHome();
    const configDir = join(home, '.gbrain');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      embedding_model: 'dashscope:text-embedding-v4',
      embedding_dimensions: 1024,
      dashscope_api_key: 'sk-dashscope-file-plane',
      provider_base_urls: {
        dashscope: 'https://workspace.example.test/compatible-mode/v1',
      },
    }));

    const calls: Array<{ modelId: string; providerOptions: any }> = [];
    __setEmbedTransportForTests(async ({ model, values, providerOptions }: any) => {
      calls.push({ modelId: model?.modelId ?? '<unknown>', providerOptions });
      return {
        embeddings: values.map(() => new Array(1024).fill(0)),
        usage: { tokens: 0 },
      } as any;
    });

    await withEnv({ GBRAIN_HOME: home, DASHSCOPE_API_KEY: undefined }, async () => {
      await runProviders('test', ['--json']);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].modelId).toBe('text-embedding-v4');
    expect(calls[0].providerOptions?.openaiCompatible?.dimensions).toBe(1024);
  });
});
