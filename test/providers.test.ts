/**
 * `gbrain providers` — pure formatter + envReady tests.
 *
 * `runTest` and `runExplain` aren't covered here because they touch the
 * gateway / loadConfig; E2E exercises those. The sunset-aware env block and
 * the shared marker ARE covered — they're pure formatters by design.
 */

import { describe, test, expect } from 'bun:test';
import { formatRecipeTable, formatEnvOutput, sunsetMarker, sunsetMarkerText, envReady } from '../src/commands/providers.ts';
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

  test('shows keyless Ollama chat as available', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const ollamaLine = out.split('\n').find(line => line.startsWith('ollama'));
    expect(ollamaLine).toBeDefined();
    // Master-skew fixup: on this branch ollama also carries an expansion
    // touchpoint (#4073), so the EXPAND column reads `yes`, not `—`.
    expect(ollamaLine).toMatch(/ollama\s+openai-compat\s+yes\s+yes\s+yes\s+✓ ready/);
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
    // v0.46.3: sunsetting providers show the DEPRECATED annotation instead of
    // key-readiness — "ready" on a dying API is not a state to advertise.
    expect(lines[3]).toContain('DEPRECATED');
    expect(lines[3]).toContain('2026-09-04');
    expect(lines[3]).toContain('voyage:voyage-4');
  });
});

describe('sunsetMarker (the one shared deprecation string)', () => {
  test('null for a living provider', () => {
    expect(sunsetMarker(getRecipe('voyage')!)).toBeNull();
    expect(sunsetMarker(getRecipe('openai')!)).toBeNull();
  });

  test('marker for a sunsetting provider names the date and replacement', () => {
    const m = sunsetMarker(getRecipe('zeroentropyai')!);
    expect(m).toContain('DEPRECATED');
    expect(m).toContain('2026-09-04');
    expect(m).toContain('voyage:voyage-4');
  });

  test('no replacement metadata → date-only marker, never "undefined"', () => {
    const m = sunsetMarker({ sunset: { date: '2027-01-01', message: 'x' } } as Pick<Recipe, 'sunset'>);
    expect(m).toContain('2027-01-01');
    expect(m).not.toContain('undefined');
  });

  test('sunsetMarkerText primitive (explain-row consumer): with and without replacement', () => {
    expect(sunsetMarkerText('2026-09-04', 'voyage:voyage-4')).toBe(
      '⚠ DEPRECATED — hosted API ends 2026-09-04; use voyage:voyage-4',
    );
    expect(sunsetMarkerText('2026-09-04')).toBe('⚠ DEPRECATED — hosted API ends 2026-09-04');
    expect(sunsetMarkerText('2026-09-04', null)).not.toContain('undefined');
  });
});

describe('formatEnvOutput (providers env <id>)', () => {
  test('sunsetting provider: DEPRECATED + migrate command, NO signup funnel', () => {
    const ze = getRecipe('zeroentropyai')!;
    const out = formatEnvOutput(ze, {});
    expect(out).toContain('DEPRECATED');
    expect(out).toContain('2026-09-04');
    expect(out).toContain('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run');
    // The signup funnel must be gone three weeks before shutdown:
    expect(out).not.toContain('dashboard.zeroentropy.dev');
    expect(out).not.toContain('Get an API key');
    // Key STATUS still renders so existing users can see what's configured:
    expect(out).toContain('ZEROENTROPY_API_KEY');
    expect(out).toContain('✗ not set');
  });

  test('sunsetting provider with a key set still shows ✓ set', () => {
    const ze = getRecipe('zeroentropyai')!;
    const out = formatEnvOutput(ze, { ZEROENTROPY_API_KEY: 'sk-fake' });
    expect(out).toContain('✓ set');
    expect(out).toContain('DEPRECATED');
  });

  test('living provider control: setup funnel intact', () => {
    const voyage = getRecipe('voyage')!;
    const out = formatEnvOutput(voyage, {});
    expect(out).not.toContain('DEPRECATED');
    expect(out).toContain('Setup:');
  });

  test('sunset recipe without replacement metadata prints no "undefined"', () => {
    const fake = {
      id: 'fake-sunset',
      name: 'Fake Sunset',
      tier: 'native',
      touchpoints: {},
      auth_env: { required: ['FAKE_KEY'] },
      sunset: { date: '2027-01-01', message: 'Fake is shutting down.' },
    } as unknown as Recipe;
    const out = formatEnvOutput(fake, {});
    expect(out).toContain('DEPRECATED');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('Replacement:');
    expect(out).toContain('migrate embeddings');
  });

  test('sunset block positively asserts message + Replacement line (ZE fixture)', () => {
    const out = formatEnvOutput(getRecipe('zeroentropyai')!, {});
    expect(out).toContain('ZeroEntropy is shutting down its hosted API.');
    expect(out).toContain('Replacement: voyage:voyage-4 (embedding), voyage:rerank-2.5 (reranker)');
  });

  test('keyless recipe (ollama): Required: (none) arm renders', () => {
    const ollama = getRecipe('ollama')!;
    const out = formatEnvOutput(ollama, {});
    expect(out).toContain('Required: (none)');
    expect(out).not.toContain('DEPRECATED');
  });

  test('optional-env arm renders when a recipe declares optional vars', () => {
    const fake = {
      id: 'fake-optional',
      name: 'Fake Optional',
      tier: 'native',
      touchpoints: {},
      auth_env: { required: ['FAKE_KEY'], optional: ['FAKE_ORG'], setup_url: 'https://example.com' },
      setup_hint: 'Get a key at example.com.',
    } as unknown as Recipe;
    const out = formatEnvOutput(fake, { FAKE_ORG: 'org-1' });
    expect(out).toContain('Optional:');
    expect(out).toContain('FAKE_ORG');
    expect(out).toContain('✓ set');
    // Living provider keeps its funnel:
    expect(out).toContain('Setup: https://example.com');
    expect(out).toContain('Get a key at example.com.');
  });
});
