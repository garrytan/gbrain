import { describe, test, expect } from 'bun:test';
import { versionRoot, maybeAttachVersionSuffixHint } from '../src/core/ai/base-url-probe.ts';
import {
  probeModel,
  probeEmbeddingReachability,
  probeRerankerReachability,
} from '../src/commands/models.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import type { AIGatewayConfig } from '../src/core/ai/types.ts';

/**
 * `gbrain models doctor` — the openai-compatible-proxy base-URL classifier.
 *
 * On an auth (401/403) or model_not_found (404) probe failure, the doctor GETs
 * `/models` at the configured base URL and each canonical version off its root,
 * classifies the status codes, and (in the auth `use-verified` case) runs one
 * unauthenticated control-probe to confirm the key. Tests inject the transport
 * (`chat`/`embed`/`rerank`) and a header-aware stub `fetch` (so a route can
 * answer differently with and without the bearer, exercising the control-probe),
 * with zero network. Reverting any probe-site hint call fails a wiring test.
 */

/**
 * Coverage of the #3553 review (v0.42.69.0 shipped the static hint unchanged, so
 * all four blockers are live on master; this replacement closes them):
 *   - Blocker 1 (the gate fired on a recipe's own versioned default, e.g. zhipu
 *     `.../paas/v4`, so a bad key was told to append `/v1` onto a `/v4` route):
 *     the "#3553 blocker 1" test below. A version is recommended only when its
 *     `/models` answers 200, so a bad key never produces a bogus append.
 *   - Blocker 2 (the shipped tests exercised only the pure helper; the wiring
 *     had no coverage): the "probe-site wiring (discrimination)" block drives the
 *     full path and fails if any hint call is reverted.
 *   - Blocker 3 (only `probeModel` was patched; the embedding and reranker probes
 *     hit the same trap): the wiring block covers all three sites.
 *   - Blocker 4 (a hand-rolled `base_urls` lookup that duplicated half of
 *     `applyOpenAICompatConfig`): structural — resolution now goes through
 *     `applyOpenAICompatConfig` / `applyResolveAuth` / `authToHeaders` /
 *     `requireConfig`, which every `classify` case drives via `deps.cfg`.
 *
 * Providers that serve NO `/models` list (Voyage = embeddings only; ZeroEntropy,
 * the default reranker = `/v1/models/rerank` only) are the all-404 cases: the
 * "wrong-endpoint" test (auth -> leads with the key, since the host is reachable)
 * and the model_not_found "silent: all 404" test (a model-name typo -> no
 * misleading "fix your URL").
 */

type ProbeResult = Awaited<ReturnType<typeof probeModel>>;
type ChatFn = typeof import('../src/core/ai/gateway.ts').chat;
type EmbedFn = typeof import('../src/core/ai/gateway.ts').embed;
type RerankFn = typeof import('../src/core/ai/gateway.ts').rerank;
type RouteSpec = number | 'error' | { auth: number; noauth: number };

const LITELLM_CHAT = 'litellm:gpt-4o';
const LITELLM_EMBED = 'litellm:text-embedding-3-large';
const LITELLM_RERANK = 'litellm:rerank-x';

function cfg(base: string): AIGatewayConfig {
  return { env: { LITELLM_API_KEY: 'test-key' }, base_urls: { litellm: base } };
}

/** Stub `fetch` routed by URL suffix. A route may answer differently based on
 *  whether the Authorization header is present ({auth,noauth}); `'error'` throws. */
function stubFetch(routes: Record<string, RouteSpec>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const hasAuth = !!(init?.headers && (init.headers as Record<string, string>).Authorization);
    for (const [suffix, spec] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        const status = typeof spec === 'object' ? (hasAuth ? spec.auth : spec.noauth) : spec;
        if (status === 'error') throw new Error('ECONNREFUSED');
        return { status } as Response;
      }
    }
    throw new Error(`unrouted probe url: ${url}`);
  }) as unknown as typeof fetch;
}

const throwAuth: ChatFn = (async () => {
  throw new Error('401 Unauthorized');
}) as unknown as ChatFn;
const throwAuthEmbed: EmbedFn = (async () => {
  throw new Error('401 Unauthorized');
}) as unknown as EmbedFn;
const throwAuthRerank: RerankFn = (async () => {
  throw new Error('401 Unauthorized');
}) as unknown as RerankFn;

function result(status = 'auth', model = LITELLM_CHAT): ProbeResult {
  return { model, touchpoint: 'chat', status: status as ProbeResult['status'], message: 'x', elapsed_ms: 0 };
}

/** (configured `/models`, `/v1/models`, `/v1beta/models`) off a bare `localhost:4000`. */
function routes(models: RouteSpec, v1: RouteSpec, v1beta: RouteSpec): Record<string, RouteSpec> {
  return {
    'localhost:4000/models': models,
    'localhost:4000/v1/models': v1,
    'localhost:4000/v1beta/models': v1beta,
  };
}
/** (configured `/v4/models`, `/v1/models`, `/v1beta/models`) for a versioned base. */
function v4Routes(v4: RouteSpec, v1: RouteSpec, v1beta: RouteSpec): Record<string, RouteSpec> {
  return {
    'localhost:4000/v4/models': v4,
    'localhost:4000/v1/models': v1,
    'localhost:4000/v1beta/models': v1beta,
  };
}

// A bare proxy where /v1 is the real route, /v1/models requires auth and the key is valid.
const V1_CONFIRMED = routes(404, { auth: 200, noauth: 401 }, 404);

async function classify(base: string, fetchRoutes: Record<string, RouteSpec>, status = 'auth'): Promise<string | undefined> {
  const r = result(status);
  await maybeAttachVersionSuffixHint(r, LITELLM_CHAT, 'chat', { cfg: cfg(base), fetchImpl: stubFetch(fetchRoutes) });
  return r.fix;
}

describe('versionRoot (append vs switch)', () => {
  test('a bare base URL is its own root', () => {
    expect(versionRoot('http://localhost:4000')).toBe('http://localhost:4000');
    expect(versionRoot('https://proxy.internal/api')).toBe('https://proxy.internal/api');
  });
  test('a trailing /vN (with optional channel + slash) is stripped', () => {
    expect(versionRoot('http://localhost:4000/v1')).toBe('http://localhost:4000');
    expect(versionRoot('http://localhost:4000/v1/')).toBe('http://localhost:4000');
    expect(versionRoot('https://open.bigmodel.cn/api/paas/v4')).toBe('https://open.bigmodel.cn/api/paas');
    expect(versionRoot('https://x.example/v1beta')).toBe('https://x.example');
  });
});

describe('auth-trigger verdicts', () => {
  test('use-verified (confident): control-probe proves the key -> "authenticates", append', async () => {
    const fix = await classify('http://localhost:4000', V1_CONFIRMED);
    expect(fix).toContain('authenticates');
    expect(fix).toContain('append /v1');
  });

  test('use-verified (confident, versioned): wrong version + key valid -> switch, "authenticates"', async () => {
    const fix = await classify('http://localhost:4000/v4', v4Routes(404, { auth: 200, noauth: 403 }, 404));
    expect(fix).toContain('authenticates');
    expect(fix).toContain('switch /v4 to /v1');
  });

  test('switch-or-key (public /models): both signals, no "authenticates"', async () => {
    // configured 401 (exists, rejected), /v1 200 but PUBLIC (200 without the key too).
    const fix = await classify('http://localhost:4000', routes(401, { auth: 200, noauth: 200 }, 404));
    expect(fix?.toLowerCase()).toContain('check the api key');
    expect(fix).toContain('append /v1');
    expect(fix).not.toContain('authenticates');
  });

  test('use-and-key: configured 404, versioned path 401 -> fix URL AND flag credentials', async () => {
    const fix = await classify('http://localhost:4000', routes(404, 401, 404));
    expect(fix).toContain('/v1');
    expect(fix).toContain('404');
    expect(fix?.toLowerCase()).toContain('key');
  });
  test('use-and-key (403 variant)', async () => {
    const fix = await classify('http://localhost:4000', routes(404, 403, 404));
    expect(fix).toContain('403');
    expect(fix?.toLowerCase()).toContain('permissions');
  });

  test('key-or-model: configured 200 -> URL works, check key or model access (touchpoint-agnostic)', async () => {
    const fix = await classify('http://localhost:4000', routes(200, 404, 404));
    expect(fix).toContain('working');
    expect(fix).toContain("model's access");
    expect(fix).not.toContain('chat model');
    expect(fix).not.toContain('append');
    expect(fix).not.toContain('switch');
  });

  test('key-only (401): configured exists, no other version -> URL fine, check the key', async () => {
    const fix = await classify('http://localhost:4000', routes(401, 404, 404));
    expect(fix).toContain('401');
    expect(fix?.toLowerCase()).toContain('key');
    expect(fix).not.toContain('append');
  });
  test('key-only (403)', async () => {
    const fix = await classify('http://localhost:4000', routes(403, 404, 404));
    expect(fix).toContain('403');
    expect(fix?.toLowerCase()).toContain('permissions');
  });
  test('key-only (null alternate): a transport-error alternate still yields key-only', async () => {
    const fix = await classify('http://localhost:4000', routes(401, 404, 'error'));
    expect(fix?.toLowerCase()).toContain('key');
    expect(fix).not.toContain('append');
  });

  test('#3553 blocker 1: a bad key on a versioned base (zhipu .../paas/v4 shape) -> key-only, never a bogus append /v1', async () => {
    // The shipped static hint gated on "openai-compat AND base does not end in
    // /v1", which fired on zhipu's own /paas/v4 default and told a bad ZHIPUAI
    // key to append /v1 onto a /v4 route. The probe never false-fires: /v4/models
    // 401 (real route, bad key), /v1 + /v1beta 404 (zhipu serves no /v1) ->
    // key-only ("check the key"), not append.
    const fix = await classify('https://open.bigmodel.cn/api/paas/v4', {
      'paas/v4/models': 401,
      'paas/v1/models': 404,
      'paas/v1beta/models': 404,
    });
    expect(fix?.toLowerCase()).toContain('key');
    expect(fix).not.toContain('append');
    expect(fix).not.toContain('switch');
  });

  test('wrong-endpoint: all 404 -> leads with the key, host/path secondary (no overclaim)', async () => {
    // No-/models-list providers (Voyage embeddings, the default ZeroEntropy
    // reranker) 404 every /models. Reached via a 401, the host is proven
    // reachable and the real endpoint auth-gated, so lead with the key; never
    // a false "the base URL is wrong".
    const fix = await classify('http://localhost:4000', routes(404, 404, 404));
    expect(fix?.toLowerCase()).toContain('key');
    expect(fix).toContain('host and path');
    expect(fix).not.toContain('does not point at an openai-compatible API');
  });

  test('precedence: configured 200 wins over an alternate 200 -> key-or-model', async () => {
    const fix = await classify('http://localhost:4000', routes(200, 200, 200));
    expect(fix).toContain('working');
    expect(fix).not.toContain('append');
  });

  test('inconclusive: 401 everywhere -> no hint', async () => {
    expect(await classify('http://localhost:4000', routes(401, 401, 401))).toBeUndefined();
  });
  test('inconclusive: 5xx at a versioned path is not "unauthorized" -> no hint', async () => {
    expect(await classify('http://localhost:4000', routes(404, 500, 404))).toBeUndefined();
  });
  test('inconclusive: 5xx at the configured path -> no hint', async () => {
    expect(await classify('http://localhost:4000', routes(500, 404, 404))).toBeUndefined();
  });
  test('inconclusive: all transport errors -> no hint', async () => {
    expect(await classify('http://localhost:4000', routes('error', 'error', 'error'))).toBeUndefined();
  });
});

describe('model_not_found-trigger verdicts (only a 200 speaks)', () => {
  test('configured 200 -> model-name: URL correct, check the model name', async () => {
    const fix = await classify('http://localhost:4000', routes(200, 404, 404), 'model_not_found');
    expect(fix).toContain('correct');
    expect(fix).toContain('model');
    expect(fix).not.toContain('append');
    expect(fix).not.toContain('switch');
  });
  test('alternate 200 -> use-verified (append), explains the model-not-found, no key claim', async () => {
    const fix = await classify('http://localhost:4000', routes(404, 200, 404), 'model_not_found');
    expect(fix).toContain('append /v1');
    expect(fix).toContain('model-not-found');
    expect(fix).not.toContain('authenticates');
  });
  test('versioned alternate 200 -> switch', async () => {
    const fix = await classify('http://localhost:4000/v4', v4Routes(404, 200, 404), 'model_not_found');
    expect(fix).toContain('switch /v4 to /v1');
  });
  test('silent: all 404 -> no hint (no wrong-endpoint, no key wording)', async () => {
    // A no-/models provider (Voyage / ZeroEntropy) + a model-name typo: all
    // /models 404 -> stay silent so the raw model-not-found stands, never a
    // misleading "fix your URL".
    expect(await classify('http://localhost:4000', routes(404, 404, 404), 'model_not_found')).toBeUndefined();
  });
  test('silent: configured 401 with no alternate 200 -> no hint', async () => {
    expect(await classify('http://localhost:4000', routes(401, 404, 404), 'model_not_found')).toBeUndefined();
    expect(await classify('http://localhost:4000', routes(401, 401, 401), 'model_not_found')).toBeUndefined();
  });
});

describe('per-run memo cache', () => {
  test('a second site with the same base reuses the verdict without re-fetching', async () => {
    const cache = new Map<string, string | undefined>();
    const r1 = result();
    await maybeAttachVersionSuffixHint(r1, LITELLM_CHAT, 'chat', {
      cfg: cfg('http://localhost:4000'), fetchImpl: stubFetch(V1_CONFIRMED), cache,
    });
    expect(r1.fix).toContain('/v1');
    // Second call: a fetch that would throw if invoked; a cache hit avoids it.
    const throwFetch = (async () => { throw new Error('must not fetch on a cache hit'); }) as unknown as typeof fetch;
    const r2 = result();
    await maybeAttachVersionSuffixHint(r2, LITELLM_CHAT, 'chat', {
      cfg: cfg('http://localhost:4000'), fetchImpl: throwFetch, cache,
    });
    expect(r2.fix).toBe(r1.fix);
  });
});

describe('gate exclusions (no probe at all)', () => {
  test('a native provider is never probed', async () => {
    const r = result('auth', 'anthropic:claude-sonnet-4-6');
    let fetched = false;
    await maybeAttachVersionSuffixHint(r, 'anthropic:claude-sonnet-4-6', 'chat', {
      cfg: { env: {}, base_urls: {} },
      fetchImpl: (async () => { fetched = true; return { status: 200 } as Response; }) as unknown as typeof fetch,
    });
    expect(r.fix).toBeUndefined();
    expect(fetched).toBe(false);
  });
  test('a non-auth, non-model_not_found failure is never probed', async () => {
    const r = result('network');
    let fetched = false;
    await maybeAttachVersionSuffixHint(r, LITELLM_CHAT, 'chat', {
      cfg: cfg('http://localhost:4000'),
      fetchImpl: (async () => { fetched = true; return { status: 200 } as Response; }) as unknown as typeof fetch,
    });
    expect(r.fix).toBeUndefined();
    expect(fetched).toBe(false);
  });
});

// #3553 blockers 2 (the shipped tests covered only the pure helper) + 3 (only
// probeModel was patched; the embedding and reranker probes hit the same trap):
// these drive the wiring end-to-end at ALL THREE probe sites; reverting any
// site's hint call drops exactly one test.
describe('probe-site wiring (discrimination — fails if a hint call is reverted)', () => {
  test('probeModel: a chat 401 attaches the /v1 hint', async () => {
    const r = await probeModel(LITELLM_CHAT, 'chat', {
      chat: throwAuth, cfg: cfg('http://localhost:4000'), fetchImpl: stubFetch(V1_CONFIRMED),
    });
    expect(r.status).toBe('auth');
    expect(r.fix).toContain('/v1');
  });
  test('probeModel: a reachable chat probe attaches no hint', async () => {
    const r = await probeModel(LITELLM_CHAT, 'chat', {
      chat: (async () => ({})) as unknown as ChatFn, cfg: cfg('http://localhost:4000'), fetchImpl: stubFetch({}),
    });
    expect(r.status).toBe('ok');
    expect(r.fix).toBeUndefined();
  });
  test('probeEmbeddingReachability: an embedding 401 attaches the /v1 hint', async () => {
    configureGateway({ env: { LITELLM_API_KEY: 'test-key' }, base_urls: { litellm: 'http://localhost:4000' }, embedding_model: LITELLM_EMBED });
    const r = await probeEmbeddingReachability({
      embed: throwAuthEmbed, cfg: cfg('http://localhost:4000'), fetchImpl: stubFetch(V1_CONFIRMED),
    });
    expect(r?.status).toBe('auth');
    expect(r?.fix).toContain('/v1');
  });
  test('probeRerankerReachability: a reranker 401 attaches the /v1 hint', async () => {
    const rerankerConfig: Record<string, string> = { 'search.reranker.model': LITELLM_RERANK, 'search.reranker.enabled': 'true' };
    const engine = {
      async getConfig(key: string): Promise<string | null> { return rerankerConfig[key] ?? null; },
    } as unknown as Parameters<typeof probeRerankerReachability>[0];
    const r = await probeRerankerReachability(engine, {
      rerank: throwAuthRerank, cfg: cfg('http://localhost:4000'), fetchImpl: stubFetch(V1_CONFIRMED),
    });
    expect(r?.status).toBe('auth');
    expect(r?.fix).toContain('/v1');
  });
});
