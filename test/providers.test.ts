/**
 * `gbrain providers` — pure formatter + envReady tests.
 *
 * `runTest` and `runExplain` aren't covered here because they touch the
 * gateway / loadConfig; E2E exercises those.
 */

import { describe, test, expect } from 'bun:test';
import { formatRecipeTable, envReady, formatOAuthStatus, buildProviderOptionsForExplain } from '../src/commands/providers.ts';
import { listRecipes, getRecipe } from '../src/core/ai/recipes/index.ts';
import type { Recipe } from '../src/core/ai/types.ts';

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

  test('openai-codex row uses OAuth readiness, not env-var readiness', () => {
    const codex = getRecipe('openai-codex');
    expect(codex).toBeDefined();
    const out = formatRecipeTable([codex!], {}, {
      'openai-codex': { status: 'cache_missing', ready: false, hint: 'refresh required' },
    });
    const line = out.split('\n').find(l => l.startsWith('openai-codex'));
    expect(line).toBeDefined();
    expect(line).toContain('yes');
    expect(line).toContain('✗ oauth cache_missing');
  });
});

describe('openai-codex providers explain integration', () => {
  test('formatOAuthStatus maps readiness states to safe short labels', () => {
    expect(formatOAuthStatus({ status: 'ready', ready: true, hint: 'ok' })).toBe('✓ oauth ready');
    expect(formatOAuthStatus({ status: 'not_logged_in', ready: false, hint: 'login' })).toBe('✗ oauth not_logged_in');
    expect(formatOAuthStatus({ status: 'token_present', ready: false, hint: 'refresh' })).toBe('✗ oauth token_present');
  });

  test('buildProviderOptionsForExplain includes openai-codex with oauth readiness metadata', () => {
    const options = buildProviderOptionsForExplain(listRecipes(), {
      'openai-codex': { status: 'ready', ready: true, hint: 'ok', models_supported: 2 },
    }, { ollamaReady: false });
    const codexChat = options.find(o => o.id === 'openai-codex:dynamic' && o.touchpoint === 'chat');
    expect(codexChat).toBeDefined();
    expect(codexChat?.env_ready).toBe(true);
    expect(codexChat?.auth_status).toBe('ready');
    expect(codexChat?.models_supported).toBe(2);
  });
});
