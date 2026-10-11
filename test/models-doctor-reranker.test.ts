/**
 * v0.40.6.1 — gbrain models doctor reranker probe divergence fix.
 *
 * Pre-v0.40.6.1 the reranker probe read `getRerankerModel()` from the
 * gateway, which is fed from `GBrainConfig.reranker_model` — a file-plane
 * field nothing writes. Meanwhile live search resolves
 * `search.reranker.model` from the DB config plane via `resolveSearchMode`.
 * The two paths could disagree silently: doctor said "not configured"
 * while every search call was using a mode default.
 *
 * `resolveLiveRerankerModel(engine)` is the new helper that reads the
 * same path live search uses. These tests pin its behavior across the
 * config sources mode.ts knows about.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { probeRerankerReachability, resolveLiveRerankerModel } from '../src/commands/models.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

/**
 * Minimal engine stub matching the `{ getConfig(key): Promise<string|null> }`
 * shape `loadSearchModeConfig` requires. Keeps the test hermetic — no
 * BrainEngine, no DB, no schema. The unused engine methods would throw
 * if called, surfacing any accidental hop into wider engine surface.
 */
function makeEngineStub(configMap: Record<string, string>) {
  return {
    async getConfig(key: string): Promise<string | null> {
      return configMap[key] ?? null;
    },
    // Any other method call should fail the test loudly.
  } as any;
}

afterEach(() => {
  resetGateway();
});

describe('resolveLiveRerankerModel — divergence fix', () => {
  test('reads search.reranker.model from the DB plane (the path live search uses)', async () => {
    configureGateway({ env: {} }); // gateway has NO reranker_model set
    const engine = makeEngineStub({
      'search.reranker.model': 'llama-server-reranker:qwen3-reranker-4b',
      'search.reranker.enabled': 'true',
    });
    const resolved = await resolveLiveRerankerModel(engine);
    expect(resolved).toBe('llama-server-reranker:qwen3-reranker-4b');
  });

  test('returns the mode-bundle default when no override is set (balanced enables voyage:rerank-2.5)', async () => {
    // balanced mode bundle has reranker_enabled: true + reranker_model:
    // 'voyage:rerank-2.5' baked in (v0.48.2 flip). Pre-fix this case
    // returned undefined; post-fix doctor sees what search actually uses.
    configureGateway({ env: {} });
    const engine = makeEngineStub({});
    const resolved = await resolveLiveRerankerModel(engine);
    expect(resolved).toBe('voyage:rerank-2.5');
  });

  test('returns undefined when reranker is explicitly disabled via config', async () => {
    configureGateway({ env: {} });
    const engine = makeEngineStub({
      'search.reranker.enabled': 'false',
    });
    const resolved = await resolveLiveRerankerModel(engine);
    expect(resolved).toBeUndefined();
  });

  test('config override beats the mode default', async () => {
    configureGateway({ env: {} });
    const engine = makeEngineStub({
      'search.mode': 'balanced',
      'search.reranker.model': 'llama-server-reranker:my-alias',
      'search.reranker.enabled': 'true',
    });
    const resolved = await resolveLiveRerankerModel(engine);
    expect(resolved).toBe('llama-server-reranker:my-alias');
  });

  test('engine.getConfig throws per-key → still returns mode-bundle default (live search behavior)', async () => {
    // Verifies the divergence fix is "graceful all the way down": if the DB
    // is intermittently failing, doctor still reports what live search
    // would resolve to, not undefined. `loadSearchModeConfig` swallows
    // per-key getConfig errors via its internal safeGet wrapper, so the
    // mode bundle default surfaces normally — doctor reports the truth
    // about what would happen at search time.
    configureGateway({ env: { VOYAGE_API_KEY: 'sk-test' } });
    const engine = {
      async getConfig(): Promise<string | null> {
        throw new Error('DB unreachable');
      },
    } as any;
    const resolved = await resolveLiveRerankerModel(engine);
    // balanced mode bundle is the safety fallback when search.mode is unset
    // (and here, every config read failed) — and balanced enables
    // voyage:rerank-2.5 by default (v0.48.2).
    expect(resolved).toBe('voyage:rerank-2.5');
  });
});

describe('probeRerankerReachability — discrimination (#6381)', () => {
  const engine = makeEngineStub({ 'search.reranker.model': 'llama-server-reranker:qwen3-reranker-0.6b', 'search.reranker.enabled': 'true' });
  type Rerank = NonNullable<Parameters<typeof probeRerankerReachability>[1]>['rerank'];
  const stub = (scores: Array<{ index: number; relevanceScore: number }>, seen?: { documents?: string[] }): Rerank =>
    (async (input: { documents: string[] }) => { if (seen) seen.documents = input.documents; return scores; }) as unknown as Rerank;

  test('a broken conversion that scores both passages near zero is a config finding with the doc fix', async () => {
    configureGateway({ env: {} });
    const r = await probeRerankerReachability(engine, { rerank: stub([{ index: 0, relevanceScore: 1e-28 }, { index: 1, relevanceScore: 3e-29 }]) });
    expect(r?.status).toBe('config');
    expect(r?.message).toContain('unrelated passage as high as a relevant one');
    expect(r?.fix).toContain('docs/ai-providers/llama-server-reranker.md');
  });

  test('a reranker that ranks the relevant passage clearly higher is ok; the probe sends one relevant and one unrelated passage', async () => {
    configureGateway({ env: {} });
    const seen: { documents?: string[] } = {};
    const r = await probeRerankerReachability(engine, { rerank: stub([{ index: 1, relevanceScore: 0.01 }, { index: 0, relevanceScore: 0.97 }], seen) });
    expect(r?.status).toBe('ok');
    expect(seen.documents).toHaveLength(2);
  });

  test('an inverted ranking and a response missing a passage are config findings', async () => {
    configureGateway({ env: {} });
    expect((await probeRerankerReachability(engine, { rerank: stub([{ index: 0, relevanceScore: 0.1 }, { index: 1, relevanceScore: 0.9 }]) }))?.status).toBe('config');
    const missing = await probeRerankerReachability(engine, { rerank: stub([{ index: 0, relevanceScore: 0.9 }]) });
    expect(missing?.status).toBe('config');
    expect(missing?.message).toContain('did not return a score for both');
  });
});
