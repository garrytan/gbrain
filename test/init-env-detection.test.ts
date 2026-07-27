/**
 * T5 — env-detection helpers in resolveAIOptions.
 *
 * These tests exercise the exported pure helpers (groupReadyByProvider,
 * findEnvKeyTypos) with hermetic env injections. The resolveAIOptions
 * orchestration itself is exercised end-to-end via T12's
 * test/e2e/init-fresh-pglite.test.ts (PTY-based, real CLI).
 *
 * Per CLAUDE.md test isolation rules: env mutations would normally need
 * `withEnv`, but these helpers accept env as an argument — purer DI, no
 * process.env touched, no quarantine needed.
 */

import { describe, test, expect } from 'bun:test';
import { groupReadyByProvider, findEnvKeyTypos, seedAIOptionsFromConfig } from '../src/commands/init.ts';

describe('groupReadyByProvider — embedding touchpoint', () => {
  test('OPENAI_API_KEY alone → openai is ready', async () => {
    const got = await groupReadyByProvider('embedding', { OPENAI_API_KEY: 'sk-test' });
    expect(got.map(p => p.recipeId)).toContain('openai');
  });

  test('VOYAGE_API_KEY alone → voyage is ready', async () => {
    const got = await groupReadyByProvider('embedding', { VOYAGE_API_KEY: 'pa-test' });
    expect(got.map(p => p.recipeId)).toContain('voyage');
  });

  test('ZEROENTROPY_API_KEY alone → zeroentropyai is ready', async () => {
    const got = await groupReadyByProvider('embedding', { ZEROENTROPY_API_KEY: 'ze-test' });
    expect(got.map(p => p.recipeId)).toContain('zeroentropyai');
  });

  test('OPENAI_API_KEY + VOYAGE_API_KEY → both providers in ready list', async () => {
    const got = await groupReadyByProvider('embedding', {
      OPENAI_API_KEY: 'sk-test',
      VOYAGE_API_KEY: 'pa-test',
    });
    const ids = got.map(p => p.recipeId);
    expect(ids).toContain('openai');
    expect(ids).toContain('voyage');
  });

  test('each provider appears at most once (codex finding #2 dedup)', async () => {
    const got = await groupReadyByProvider('embedding', {
      OPENAI_API_KEY: 'sk-test',
      VOYAGE_API_KEY: 'pa-test',
      ZEROENTROPY_API_KEY: 'ze-test',
    });
    const ids = got.map(p => p.recipeId);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  test('empty-string env var counts as not set', async () => {
    const got = await groupReadyByProvider('embedding', { OPENAI_API_KEY: '' });
    expect(got.map(p => p.recipeId)).not.toContain('openai');
  });

  test('Anthropic alone → not in embedding ready (no embedding touchpoint on anthropic recipe)', async () => {
    const got = await groupReadyByProvider('embedding', { ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(got.map(p => p.recipeId)).not.toContain('anthropic');
  });

  test('regression: bug reporter scenario — only OPENAI_API_KEY set → openai picked, ZE not present', async () => {
    const got = await groupReadyByProvider('embedding', { OPENAI_API_KEY: 'sk-test' });
    const ids = got.map(p => p.recipeId);
    expect(ids).toContain('openai');
    expect(ids).not.toContain('zeroentropyai');
  });
});

describe('groupReadyByProvider — chat touchpoint', () => {
  test('OPENAI_API_KEY → openai chat ready', async () => {
    const got = await groupReadyByProvider('chat', { OPENAI_API_KEY: 'sk-test' });
    expect(got.map(p => p.recipeId)).toContain('openai');
  });

  test('ZEROENTROPY_API_KEY alone → no chat ready (ZE has no chat touchpoint)', async () => {
    const got = await groupReadyByProvider('chat', { ZEROENTROPY_API_KEY: 'ze-test' });
    expect(got.map(p => p.recipeId)).not.toContain('zeroentropyai');
  });

  test('ANTHROPIC_API_KEY → anthropic chat ready', async () => {
    const got = await groupReadyByProvider('chat', { ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(got.map(p => p.recipeId)).toContain('anthropic');
  });
});

describe('groupReadyByProvider — expansion touchpoint', () => {
  test('OPENAI_API_KEY → openai expansion ready', async () => {
    const got = await groupReadyByProvider('expansion', { OPENAI_API_KEY: 'sk-test' });
    expect(got.map(p => p.recipeId)).toContain('openai');
  });

  test('VOYAGE_API_KEY alone → no expansion ready (Voyage is embedding-only)', async () => {
    const got = await groupReadyByProvider('expansion', { VOYAGE_API_KEY: 'pa-test' });
    expect(got.map(p => p.recipeId)).not.toContain('voyage');
  });
});

describe('findEnvKeyTypos', () => {
  test('detects OPENAPI_API_KEY → OPENAI_API_KEY', async () => {
    const got = await findEnvKeyTypos({ OPENAPI_API_KEY: 'sk-test' });
    expect(got.length).toBeGreaterThan(0);
    const openaiTypo = got.find(t => t.userSet === 'OPENAPI_API_KEY');
    expect(openaiTypo).toBeDefined();
    expect(openaiTypo!.suggested).toBe('OPENAI_API_KEY');
  });

  test('no typo when canonical name is also set (false-positive guard)', async () => {
    const got = await findEnvKeyTypos({
      OPENAPI_API_KEY: 'sk-test',
      OPENAI_API_KEY: 'sk-real',
    });
    // OPENAPI_API_KEY → OPENAI_API_KEY suggestion suppressed
    expect(got.find(t => t.userSet === 'OPENAPI_API_KEY')).toBeUndefined();
  });

  test('empty env returns no typos', async () => {
    const got = await findEnvKeyTypos({});
    expect(got).toEqual([]);
  });

  test('canonical name set produces no typo for itself', async () => {
    const got = await findEnvKeyTypos({ OPENAI_API_KEY: 'sk-test' });
    expect(got.find(t => t.userSet === 'OPENAI_API_KEY')).toBeUndefined();
  });

  test('non-API-KEY shaped vars ignored (HOME, PATH, etc.)', async () => {
    const got = await findEnvKeyTypos({ HOME: '/home/user', PATH: '/usr/bin' });
    expect(got).toEqual([]);
  });

  test('empty-string env var skipped (no suggestion)', async () => {
    const got = await findEnvKeyTypos({ OPENAPI_API_KEY: '' });
    expect(got.find(t => t.userSet === 'OPENAPI_API_KEY')).toBeUndefined();
  });

  test('detects VOYAG_API_KEY → VOYAGE_API_KEY (1 char delete)', async () => {
    const got = await findEnvKeyTypos({ VOYAG_API_KEY: 'pa-test' });
    const v = got.find(t => t.userSet === 'VOYAG_API_KEY');
    expect(v).toBeDefined();
    expect(v!.suggested).toBe('VOYAGE_API_KEY');
  });

  test('very-different name returns no typo (far beyond edit distance)', async () => {
    const got = await findEnvKeyTypos({ COMPLETELY_UNRELATED_KEY: 'foo' });
    // Should not match any canonical via Levenshtein ≤ 3.
    expect(got.find(t => t.userSet === 'COMPLETELY_UNRELATED_KEY')).toBeUndefined();
  });
});

describe('seedAIOptionsFromConfig — #1058 cold-install env fallback', () => {
  test('null config (no config.json, no DATABASE_URL) falls back to GBRAIN_* env vars', () => {
    const got = seedAIOptionsFromConfig(null, {
      GBRAIN_EMBEDDING_MODEL: 'voyage:voyage-3-large',
      GBRAIN_EMBEDDING_DIMENSIONS: '1024',
      GBRAIN_EXPANSION_MODEL: 'openai:gpt-5-mini',
      GBRAIN_CHAT_MODEL: 'anthropic:claude-sonnet-4-6',
    });
    expect(got.embedding_model).toBe('voyage:voyage-3-large');
    expect(got.embedding_dimensions).toBe(1024);
    expect(got.expansion_model).toBe('openai:gpt-5-mini');
    expect(got.chat_model).toBe('anthropic:claude-sonnet-4-6');
  });

  test('null config + no env vars → empty seed (Tier-3 detection takes over)', () => {
    const got = seedAIOptionsFromConfig(null, {});
    expect(got).toEqual({});
  });

  test('persisted config wins (loadConfig already merged env when non-null)', () => {
    const got = seedAIOptionsFromConfig(
      { engine: 'pglite', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 } as any,
      { GBRAIN_EMBEDDING_MODEL: 'voyage:voyage-3-large' },
    );
    expect(got.embedding_model).toBe('openai:text-embedding-3-small');
    expect(got.embedding_dimensions).toBe(1536);
  });

  test('embedding_disabled sentinel honored on re-init', () => {
    const got = seedAIOptionsFromConfig({ engine: 'pglite', embedding_disabled: true } as any, {});
    expect(got.noEmbedding).toBe(true);
    expect(got.embedding_model).toBeUndefined();
  });

  test('non-numeric GBRAIN_EMBEDDING_DIMENSIONS ignored, model still seeds', () => {
    const got = seedAIOptionsFromConfig(null, {
      GBRAIN_EMBEDDING_MODEL: 'voyage:voyage-3-large',
      GBRAIN_EMBEDDING_DIMENSIONS: 'not-a-number',
    });
    expect(got.embedding_model).toBe('voyage:voyage-3-large');
    expect(got.embedding_dimensions).toBeUndefined();
  });
});
