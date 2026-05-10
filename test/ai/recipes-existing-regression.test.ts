/**
 * IRON RULE regression test (D2/D12=A): the v0.32 resolveAuth refactor
 * MUST NOT change auth behavior for any of the 9 existing recipes
 * (openai, anthropic, google, deepseek, groq, ollama, litellm-proxy,
 * together, voyage).
 *
 * Pre-v0.32, openai-compatible auth was duplicated 3 times in gateway.ts
 * with subtle drift; D12=A unified all three through Recipe.resolveAuth?
 * with a default that covers existing recipes unchanged. This test pins
 * the contract so the next refactor can't silently regress it.
 *
 * Coverage:
 *  - defaultResolveAuth returns Authorization Bearer <key> when required[0] is set
 *  - throws AIConfigError when required env is missing (with recipe name + touchpoint in message)
 *  - falls back to first present optional env when required is empty (Ollama-style)
 *  - falls back to 'unauthenticated' when neither required nor optional present
 *  - applyResolveAuth converts Authorization Bearer to {apiKey} (SDK native)
 *  - applyResolveAuth converts custom headers to {headers} WITHOUT apiKey (no double-auth)
 *  - all 3 touchpoints (embedding, expansion, chat) produce identical auth shape for the same recipe+env
 *  - native recipes (openai, anthropic, google) are not consulted via resolveAuth (they use their AI-SDK adapters directly)
 */

import { describe, expect, test } from 'bun:test';
import { defaultResolveAuth, applyResolveAuth } from '../../src/core/ai/gateway.ts';
import { listRecipes, getRecipe } from '../../src/core/ai/recipes/index.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import type { Recipe } from '../../src/core/ai/types.ts';

const TOUCHPOINTS: Array<'embedding' | 'expansion' | 'chat'> = ['embedding', 'expansion', 'chat'];

describe('IRON RULE: existing 9 recipes survive the v0.32 resolveAuth refactor', () => {
  test('the 9 expected recipes are still registered', () => {
    const ids = listRecipes().map(r => r.id).sort();
    expect(ids).toEqual([
      'anthropic',
      'deepseek',
      'google',
      'groq',
      'litellm',
      'ollama',
      'openai',
      'together',
      'voyage',
    ]);
  });

  test('every recipe with a non-empty required[] returns Authorization Bearer <key>', () => {
    for (const r of listRecipes()) {
      const required = r.auth_env?.required ?? [];
      if (required.length === 0) continue;
      const env = { [required[0]]: `fake-${r.id}-key` };
      const auth = defaultResolveAuth(r, env, 'embedding');
      expect(auth.headerName).toBe('Authorization');
      expect(auth.token).toBe(`Bearer fake-${r.id}-key`);
    }
  });

  test('missing required env throws AIConfigError naming the recipe + touchpoint', () => {
    const recipesWithRequired = listRecipes().filter(r => (r.auth_env?.required ?? []).length > 0);
    expect(recipesWithRequired.length).toBeGreaterThan(0);
    for (const r of recipesWithRequired) {
      for (const tp of TOUCHPOINTS) {
        let caught: unknown;
        try {
          defaultResolveAuth(r, {}, tp);
        } catch (e) {
          caught = e;
        }
        expect(caught, `${r.id} ${tp} should throw on missing env`).toBeInstanceOf(AIConfigError);
        const msg = (caught as Error).message;
        expect(msg).toContain(r.name);
        expect(msg).toContain(tp);
        expect(msg).toContain(r.auth_env!.required[0]);
      }
    }
  });

  test('Ollama (empty required, optional set) reads first optional env', () => {
    const ollama = getRecipe('ollama');
    expect(ollama).toBeDefined();
    expect(ollama!.auth_env?.required ?? []).toEqual([]);
    const optional = ollama!.auth_env?.optional ?? [];
    expect(optional.length).toBeGreaterThan(0);
    // First optional present → returned as Bearer.
    const env = { [optional[0]]: 'http://localhost:11434' };
    const auth = defaultResolveAuth(ollama!, env, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer http://localhost:11434');
  });

  test('Ollama (no env at all) falls back to "Bearer unauthenticated"', () => {
    const ollama = getRecipe('ollama');
    const auth = defaultResolveAuth(ollama!, {}, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer unauthenticated');
  });

  test('all 3 touchpoints produce identical auth for the same recipe + env', () => {
    // Critical regression: pre-v0.32, embedding had a fallback to
    // ${recipe.id.toUpperCase()}_API_KEY that expansion and chat lacked.
    // Post-D12=A unification, all 3 touchpoints go through the same
    // resolver, so the auth shape MUST match.
    for (const r of listRecipes()) {
      if (r.implementation !== 'openai-compatible') continue;
      const required = r.auth_env?.required ?? [];
      const env: Record<string, string> = {};
      if (required.length > 0) env[required[0]] = `fake-${r.id}-key`;

      const embeddingAuth = applyResolveAuth(r, { env } as any, 'embedding');
      const expansionAuth = applyResolveAuth(r, { env } as any, 'expansion');
      const chatAuth = applyResolveAuth(r, { env } as any, 'chat');

      expect(embeddingAuth, `${r.id} embed=expand`).toEqual(expansionAuth);
      expect(expansionAuth, `${r.id} expand=chat`).toEqual(chatAuth);
    }
  });

  test('applyResolveAuth converts Authorization Bearer to {apiKey} (SDK-native path)', () => {
    const voyage = getRecipe('voyage')!;
    const env = { VOYAGE_API_KEY: 'fake-voyage-key' };
    const auth = applyResolveAuth(voyage, { env } as any, 'embedding');
    expect(auth.apiKey).toBe('fake-voyage-key');
    expect(auth.headers).toBeUndefined();
  });

  test('applyResolveAuth respects a recipe.resolveAuth override that returns a custom header', () => {
    // Synthetic recipe with a custom-header resolveAuth (Azure-style preview;
    // the actual Azure recipe lands in commit 8). Ensures the seam works.
    const fakeAzure: Recipe = {
      id: 'fake-azure',
      name: 'Fake Azure',
      tier: 'openai-compat',
      implementation: 'openai-compatible',
      auth_env: { required: ['FAKE_AZURE_API_KEY'] },
      touchpoints: {},
      resolveAuth(env) {
        const k = env.FAKE_AZURE_API_KEY;
        if (!k) throw new AIConfigError('Fake Azure requires FAKE_AZURE_API_KEY.');
        return { headerName: 'api-key', token: k };
      },
    };
    const env = { FAKE_AZURE_API_KEY: 'fake-key' };
    const auth = applyResolveAuth(fakeAzure, { env } as any, 'embedding');
    expect(auth.apiKey, 'custom-header path must NOT set apiKey').toBeUndefined();
    expect(auth.headers).toEqual({ 'api-key': 'fake-key' });
  });

  test('native-* recipes have no resolveAuth declared; they take native SDK paths', () => {
    // Confirms the architectural invariant: resolveAuth is only consulted by
    // the openai-compatible branches in instantiate{Embedding,Expansion,Chat}.
    // Native recipes (openai, anthropic, google) use createOpenAI /
    // createAnthropic / createGoogleGenerativeAI directly with the SDK's
    // own apiKey field. This test pins that resolveAuth is intentionally
    // absent on the native recipes — a future drift that adds it without
    // wiring it through the native branches would silently fail this assert.
    for (const id of ['openai', 'anthropic', 'google']) {
      const r = getRecipe(id);
      expect(r, `recipe ${id} missing`).toBeDefined();
      expect(r!.tier).toBe('native');
      expect(r!.resolveAuth, `${id} should NOT declare resolveAuth in v0.32`).toBeUndefined();
    }
  });

  test('all openai-compatible recipes have NO resolveAuth declared in v0.32 (default applies)', () => {
    // The default resolver covers all 6 existing openai-compatible recipes.
    // The first override (Azure) lands in commit 8.
    for (const r of listRecipes()) {
      if (r.implementation !== 'openai-compatible') continue;
      expect(
        r.resolveAuth,
        `${r.id} ships in v0.32 without resolveAuth (default applies)`,
      ).toBeUndefined();
    }
  });
});
