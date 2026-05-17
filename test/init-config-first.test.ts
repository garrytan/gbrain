/**
 * v0.35.0.1+ — `resolveAIOptions` reads `~/.gbrain/config.json` before applying
 * defaults. Closes upstream issue #203:
 *
 *   "init: --provider flags required even when config.json has persisted
 *    embedding settings (DX)"
 *
 * Resolution chain (each step overrides the previous on a per-field basis):
 *
 *   1. config.json (NEW seeding step)
 *   2. --model SHORTHAND (recipe lookup; sets both model + dims)
 *   3. --embedding-model VERBOSE (overrides shorthand)
 *   4. --embedding-dimensions N (overrides recipe-derived dims)
 *   5. --expansion-model / --chat-model (additive)
 *
 * Gateway defaults still apply downstream when nothing in the chain populates
 * a field — cold-start behavior unchanged.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';
import { resolveAIOptions } from '../src/commands/init.ts';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

/**
 * Build a tmpdir to use as GBRAIN_HOME, optionally seeding ~/.gbrain/config.json
 * with the given object. Tracked for afterEach cleanup.
 */
function makeBrainHome(config?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-init-config-first-'));
  tmpDirs.push(home);
  const cfgDir = join(home, '.gbrain');
  mkdirSync(cfgDir, { recursive: true });
  if (config !== undefined) {
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify(config));
  }
  return home;
}

/**
 * Every test in this file MUST `...isolateEnv()` into its `withEnv()` call.
 *
 * Why: `loadConfig()` reads `process.env.GBRAIN_DATABASE_URL`, `DATABASE_URL`,
 * `GBRAIN_EMBEDDING_*`, `GBRAIN_EXPANSION_MODEL`, `GBRAIN_CHAT_MODEL`. If the
 * runner's parent env has any of these set (CI runners with a real Postgres
 * URL, dev machines with a direnv-loaded `.envrc`, anyone running this file
 * outside the canonical `bun run test` flow), assertions about what
 * `resolveAIOptions` returns become non-deterministic — the env-vars merge
 * into loadConfig's return, which the patch under test seeds from. The test
 * stops being a deterministic pin and starts being a function of the
 * runner's environment.
 *
 * `isolateEnv()` unsets every env var that participates in the loadConfig
 * merge. Tests then override only what they need.
 */
function isolateEnv(): Record<string, string | undefined> {
  return {
    DATABASE_URL: undefined,
    GBRAIN_DATABASE_URL: undefined,
    GBRAIN_EMBEDDING_MODEL: undefined,
    GBRAIN_EMBEDDING_DIMENSIONS: undefined,
    GBRAIN_EXPANSION_MODEL: undefined,
    GBRAIN_CHAT_MODEL: undefined,
    GBRAIN_CHAT_FALLBACK_CHAIN: undefined,
    GBRAIN_EMBEDDING_MULTIMODAL: undefined,
    GBRAIN_EMBEDDING_IMAGE_OCR: undefined,
    GBRAIN_EMBEDDING_MULTIMODAL_MODEL: undefined,
    GBRAIN_EMBEDDING_IMAGE_OCR_MODEL: undefined,
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
  };
}

describe('resolveAIOptions: config-first resolution (closes #203)', () => {
  test('case 1: config-only, no flags → returns config values', async () => {
    const home = makeBrainHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      embedding_model: 'lmstudio:text-embedding-nomic-embed-text-v1.5',
      embedding_dimensions: 768,
      expansion_model: 'anthropic:claude-haiku-4-5',
      chat_model: 'anthropic:claude-haiku-4-5',
    });
    await withEnv({ ...isolateEnv(), GBRAIN_HOME: home }, async () => {
      const result = await resolveAIOptions(null, null, null, null, null);
      expect(result.embedding_model).toBe('lmstudio:text-embedding-nomic-embed-text-v1.5');
      expect(result.embedding_dimensions).toBe(768);
      expect(result.expansion_model).toBe('anthropic:claude-haiku-4-5');
      expect(result.chat_model).toBe('anthropic:claude-haiku-4-5');
    });
  });

  test('case 2: flag-only, no config → returns flag values (existing behavior preserved)', async () => {
    const home = makeBrainHome(); // no config.json on disk
    await withEnv({ ...isolateEnv(), GBRAIN_HOME: home }, async () => {
      const result = await resolveAIOptions(
        'openai:text-embedding-3-large',
        null,
        1536,
        null,
        null,
      );
      expect(result.embedding_model).toBe('openai:text-embedding-3-large');
      expect(result.embedding_dimensions).toBe(1536);
    });
  });

  test('case 3: flags override config (per-field) — flag for model, config for chat', async () => {
    const home = makeBrainHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      embedding_model: 'lmstudio:text-embedding-nomic-embed-text-v1.5',
      embedding_dimensions: 768,
      chat_model: 'anthropic:claude-haiku-4-5',
    });
    await withEnv({ ...isolateEnv(), GBRAIN_HOME: home }, async () => {
      // Flag overrides config for embedding_model + embedding_dimensions.
      // chat_model not specified on CLI → config value preserved.
      const result = await resolveAIOptions(
        'openai:text-embedding-3-large',
        null,
        1536,
        null,
        null,
      );
      expect(result.embedding_model).toBe('openai:text-embedding-3-large');
      expect(result.embedding_dimensions).toBe(1536);
      expect(result.chat_model).toBe('anthropic:claude-haiku-4-5');
    });
  });

  test('case 4: empty (cold-start, no config no flags) → empty object (existing behavior preserved)', async () => {
    const home = makeBrainHome();
    await withEnv({ ...isolateEnv(), GBRAIN_HOME: home }, async () => {
      const result = await resolveAIOptions(null, null, null, null, null);
      expect(result.embedding_model).toBeUndefined();
      expect(result.embedding_dimensions).toBeUndefined();
      expect(result.expansion_model).toBeUndefined();
      expect(result.chat_model).toBeUndefined();
    });
  });

  /**
   * Known limitation (NOT closed by this PR — tracked at #1058):
   * if a user sets `GBRAIN_EMBEDDING_MODEL` + `GBRAIN_EMBEDDING_DIMENSIONS`
   * env vars but has NO existing config.json AND no `DATABASE_URL`,
   * `loadConfig()` returns null at config.ts:135 (`if (!fileConfig && !dbUrl)
   * return null;`). The env-var merge logic below that early-return never
   * runs. This patch's seed step sees `existing === null` and skips, leaving
   * env-only callers stranded.
   *
   * This is a separate bug class from issue #203 (which is about config.json
   * being ignored). Fixing it cleanly requires either reworking the early-
   * return in loadConfig (risky: would default `inferredEngine` to 'postgres'
   * for PGLite users) or threading env-var reads through a sibling
   * `loadAIConfig()` helper. Tracked separately at #1058.
   *
   * This test pins the current (limited) behavior so any future fix in
   * either direction shows up loud in the test diff.
   */
  /**
   * Regression pin (cross-model review caught this — gstack-codex P2, round 2):
   * provider_base_urls is a sibling AI-config field that must survive re-init
   * the same way embedding_model/dimensions/expansion_model/chat_model do.
   * Without it, a user running `gbrain init --pglite` to refresh their setup
   * silently loses their custom endpoint override (e.g. self-hosted Ollama at
   * a non-default port, or a corporate OpenAI-compatible proxy). The gateway
   * then falls back to the recipe default endpoint and every embed silently
   * hits the wrong server.
   */
  test('case 5c: provider_base_urls preserved on re-init', async () => {
    const home = makeBrainHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      embedding_model: 'lmstudio:text-embedding-nomic-embed-text-v1.5',
      embedding_dimensions: 768,
      provider_base_urls: {
        lmstudio: 'http://localhost:1234/v1',
      },
    });
    await withEnv({ ...isolateEnv(), GBRAIN_HOME: home }, async () => {
      const result = await resolveAIOptions(null, null, null, null, null);
      expect(result.provider_base_urls).toEqual({
        lmstudio: 'http://localhost:1234/v1',
      });
    });
  });

  /**
   * Regression pin (cross-model review caught this — gstack-codex P2):
   * If a user has 768-dim/lmstudio in config and runs `gbrain init --pglite
   * --embedding-model openai:text-embedding-3-large` (switching providers,
   * no explicit --embedding-dimensions), the patch must NOT carry the seeded
   * 768-dim over to OpenAI. The verbose branch needs to detect "model is
   * changing from the seeded value" and clear the seeded dim, so the
   * recipe-default derivation below re-fires for the new provider.
   *
   * Without this, the seeded 768 survives + the `else if (... === undefined)`
   * recipe-derive doesn't fire + OpenAI gets configured with 768-dim schema.
   * That trips the v0.28.5 dim-check on first embed or, on a fresh brain,
   * silently corrupts the schema until embed time.
   */
  test('case 5b: --embedding-model switches provider away from config → dims cleared, recipe-default re-derives', async () => {
    const home = makeBrainHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      embedding_model: 'lmstudio:text-embedding-nomic-embed-text-v1.5',
      embedding_dimensions: 768,
    });
    await withEnv({ ...isolateEnv(), GBRAIN_HOME: home }, async () => {
      const result = await resolveAIOptions(
        'openai:text-embedding-3-large', // verbose model switch
        null,
        null, // NO --embedding-dimensions
        null,
        null,
      );
      expect(result.embedding_model).toBe('openai:text-embedding-3-large');
      // OpenAI recipe's default_dims is 1536 — the seeded 768 must NOT survive.
      // If recipe lookup populates: 1536. If recipe absent (shouldn't be): undefined.
      // Either way, NOT 768 (that would be the seeded-stale-dim bug).
      expect(result.embedding_dimensions).not.toBe(768);
    });
  });

  test('case 5: env-var-only, no config, no flags → still returns empty (KNOWN LIMITATION, tracked at #1058)', async () => {
    const home = makeBrainHome();
    await withEnv({
      ...isolateEnv(),
      GBRAIN_HOME: home,
      // Then deliberately re-set the two env vars this case exercises — these
      // override isolateEnv's `undefined` defaults via object-spread precedence.
      GBRAIN_EMBEDDING_MODEL: 'lmstudio:text-embedding-nomic-embed-text-v1.5',
      GBRAIN_EMBEDDING_DIMENSIONS: '768',
    }, async () => {
      const result = await resolveAIOptions(null, null, null, null, null);
      // KNOWN: this is NOT what we'd want from a UX perspective. Env-var-only
      // users should land at 768. But loadConfig short-circuits to null when
      // no fileConfig and no dbUrl, so the env-var merge never fires.
      // Tracked at #1058 for separate fix.
      expect(result.embedding_model).toBeUndefined();
      expect(result.embedding_dimensions).toBeUndefined();
    });
  });

  /**
   * Case 6 (added after issue #203 reporter audit, 2026-05-16):
   * The v0.10.x nested config shape — what jamebobob actually filed the issue with —
   * is `{embedding: {provider, model, dimensions, base_url}}`. v0.27 (PR #257)
   * flattened to top-level fields and the migration was never written. A user
   * carrying a config.json from before that release falls through to gateway
   * defaults (OpenAI 1536) on every command because no code reads the nested shape.
   *
   * `loadConfig()` now maps the nested shape to flat fields in memory before the
   * env-merge step, so this PR closes jamebobob's exact reproducer too — not just
   * users who've already migrated to the flat shape.
   */
  test('case 6: nested v0.10.x shape (jamebobob reproducer) → mapped to flat fields', async () => {
    const home = makeBrainHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      embedding: {
        provider: 'ollama',
        model: 'bge-m3',
        dimensions: 1024,
        base_url: 'http://localhost:8085/v1',
      },
    });
    await withEnv({ ...isolateEnv(), GBRAIN_HOME: home }, async () => {
      const result = await resolveAIOptions(null, null, null, null, null);
      expect(result.embedding_model).toBe('ollama:bge-m3');
      expect(result.embedding_dimensions).toBe(1024);
      expect(result.provider_base_urls).toEqual({ ollama: 'http://localhost:8085/v1' });
    });
  });

  /**
   * Case 7: flat fields take precedence over nested if BOTH are somehow present
   * (e.g., a user re-saved a config midway through a manual edit). The flat
   * fields are the canonical v0.27+ shape; nested is the back-compat fallback.
   */
  test('case 7: flat fields win when both flat and nested present', async () => {
    const home = makeBrainHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      embedding_model: 'lmstudio:text-embedding-nomic-embed-text-v1.5',
      embedding_dimensions: 768,
      embedding: {
        provider: 'ollama',
        model: 'bge-m3',
        dimensions: 1024,
      },
    });
    await withEnv({ ...isolateEnv(), GBRAIN_HOME: home }, async () => {
      const result = await resolveAIOptions(null, null, null, null, null);
      expect(result.embedding_model).toBe('lmstudio:text-embedding-nomic-embed-text-v1.5');
      expect(result.embedding_dimensions).toBe(768);
    });
  });
});
