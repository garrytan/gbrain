/**
 * LM Studio recipe registration.
 *
 * Before this recipe existed, LM Studio was half-wired: probes.ts had a
 * probe, build-gateway-config.ts mapped LMSTUDIO_BASE_URL, and
 * commands/providers.ts probed it under `local_probes` — but `lmstudio:`
 * model strings never resolved, so `gbrain providers list` had no row to
 * select and the mapped base URL reached nothing.
 *
 * Shape mirrors `recipe-llama-server.test.ts`, the sibling user-provided-models
 * local recipe.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { resolveSchemaEmbeddingDim } from '../../src/core/embedding-dim-check.ts';
import { isModelPriceable } from '../../src/core/budget/budget-tracker.ts';
import { withEnv } from '../helpers/with-env.ts';

const MODEL = 'lmstudio:some-local-embedding-model';

describe('lmstudio recipe', () => {
  test('is registered and offers an embedding touchpoint', () => {
    const recipe = getRecipe('lmstudio');
    expect(recipe).toBeDefined();
    if (!recipe) return;
    expect(recipe.implementation).toBe('openai-compatible');
    expect(recipe.base_url_default).toBe('http://localhost:1234/v1');
    // A local server needs no credential; requiring one is what forced LM
    // Studio users onto the generic openai: provider (#4385).
    expect(recipe.auth_env?.required ?? []).toEqual([]);
    expect(recipe.auth_env?.optional ?? []).toContain('LMSTUDIO_BASE_URL');
    expect(recipe.auth_env?.optional ?? []).toContain('LMSTUDIO_API_KEY');
    const tp = recipe.touchpoints.embedding;
    expect(tp).toBeDefined();
    if (!tp) return;
    expect(tp.user_provided_models).toBe(true);
    expect(tp.models).toEqual([]);
  });

  test('default auth on a keyless local server resolves to "Bearer unauthenticated"', () => {
    // The whole point of a local recipe: no credential to hold. If this ever
    // resolved to a throw, LM Studio users would be back on the generic
    // openai: route to avoid a key requirement that should not exist.
    const recipe = getRecipe('lmstudio')!;
    const auth = defaultResolveAuth(recipe, {}, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer unauthenticated');
  });

  test('probe reports ready=false with an actionable hint when nothing is listening', async () => {
    // Guaranteed-unreachable port. withEnv restores the prior value even under
    // the shared-process parallel runner (test-isolation rule R1).
    await withEnv({ LMSTUDIO_BASE_URL: 'http://127.0.0.1:1/v1' }, async () => {
      const recipe = getRecipe('lmstudio')!;
      expect(typeof recipe.probe).toBe('function');
      const result = await recipe.probe!();
      expect(result.ready).toBe(false);
      expect(result.hint).toBeDefined();
      // The hint has to name the thing the user must go start, and the URL it
      // actually tried — a bare "not reachable" leaves them guessing which
      // port the recipe resolved.
      expect(result.hint!).toContain('LM Studio');
      expect(result.hint!).toContain('http://127.0.0.1:1/v1');
    });
  });

  test('an explicit --embedding-dimensions is accepted', () => {
    // The setup hint instructs the user to pass --embedding-dimensions <N>.
    // With default_dims: 0 every real dim is "custom", so without
    // trust_custom_dims the recipe rejects its own documented setup.
    for (const dims of [384, 1024, 4096]) {
      const result = resolveSchemaEmbeddingDim({ embedding_model: MODEL, embedding_dimensions: dims });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.dim).toBe(dims);
        expect(result.provider).toBe('lmstudio');
      }
    }
  });

  test('the pgvector column cap still rejects an absurd dim', () => {
    const result = resolveSchemaEmbeddingDim({ embedding_model: MODEL, embedding_dimensions: 20000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('pgvector');
  });

  test('omitting the dimension is still an error, not a silent zero', () => {
    // default_dims: 0 is deliberate — the wizard must not invent a dim for a
    // model only the user knows.
    const result = resolveSchemaEmbeddingDim({ embedding_model: MODEL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('positive integer');
  });

  test('embed spend is priceable at $0, like its local siblings', () => {
    // Without the FREE_LOCAL_EMBED_PROVIDERS entry a --max-cost-bounded
    // embed/reindex job hard-fails at $0 spent for LM Studio users, while
    // ollama and llama-server work.
    expect(isModelPriceable(MODEL, 'embed')).toBe(true);
    expect(isModelPriceable('ollama:some-local-embedding-model', 'embed')).toBe(true);
    expect(isModelPriceable('llama-server:some-local-embedding-model', 'embed')).toBe(true);
  });
});

/**
 * Ephemeral local OpenAI-compatible stub: answers every request with `body`
 * and records the request paths. Hermetic — a real listener on an OS-picked
 * port, no global fetch monkeypatch, so the shared-process parallel runner's
 * other files are untouched (test-isolation rule R1).
 */
function serveModels(body: unknown): { baseUrl: string; paths: string[]; stop: () => void } {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      paths.push(new URL(req.url).pathname);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    paths,
    stop: () => { server.stop(true); },
  };
}

describe('lmstudio recipe — probe shape, base URL precedence, auth', () => {
  test('reached but /v1/models returns an unexpected shape → ready:false, hint says so', async () => {
    const stub = serveModels({ hello: 'world' });
    try {
      const result = await getRecipe('lmstudio')!.probe!(stub.baseUrl);
      expect(result.ready).toBe(false);
      expect(result.hint).toContain('unexpected shape');
      expect(stub.paths).toEqual(['/v1/models']);
    } finally {
      stub.stop();
    }
  });

  test('a valid OpenAI-compatible list ({object:"list", data:[]}) → ready:true', async () => {
    const stub = serveModels({ object: 'list', data: [] });
    try {
      const result = await getRecipe('lmstudio')!.probe!(stub.baseUrl);
      expect(result.ready).toBe(true);
      expect(result.hint).toBeUndefined();
    } finally {
      stub.stop();
    }
  });

  test('an explicit baseURL argument beats LMSTUDIO_BASE_URL', async () => {
    const stub = serveModels({ object: 'list', data: [] });
    try {
      // env names a guaranteed-unreachable port; only the explicit arg can succeed.
      const result = await withEnv({ LMSTUDIO_BASE_URL: 'http://127.0.0.1:1/v1' }, () =>
        getRecipe('lmstudio')!.probe!(stub.baseUrl));
      expect(result.ready).toBe(true);
      expect(stub.paths).toEqual(['/v1/models']);
    } finally {
      stub.stop();
    }
  });

  test('LMSTUDIO_BASE_URL is honored when no explicit baseURL is passed', async () => {
    const stub = serveModels({ object: 'list', data: [] });
    try {
      const result = await withEnv({ LMSTUDIO_BASE_URL: stub.baseUrl }, () => getRecipe('lmstudio')!.probe!());
      expect(result.ready).toBe(true);
      expect(stub.paths).toEqual(['/v1/models']);
    } finally {
      stub.stop();
    }
  });

  test('auth: LMSTUDIO_API_KEY → "Bearer <key>"; only LMSTUDIO_BASE_URL → "Bearer unauthenticated"', () => {
    const recipe = getRecipe('lmstudio')!;
    expect(defaultResolveAuth(recipe, { LMSTUDIO_API_KEY: 'lm-secret' }, 'embedding').token).toBe('Bearer lm-secret');
    // URL-shaped optional envs belong to cfg.base_urls, never to auth.
    const urlOnly = defaultResolveAuth(recipe, { LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1' }, 'embedding');
    expect(urlOnly.headerName).toBe('Authorization');
    expect(urlOnly.token).toBe('Bearer unauthenticated');
  });
});
