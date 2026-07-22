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
import { resolveLiveRerankerModel } from '../src/commands/models.ts';
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

  test('returns the mode-bundle default when no override is set (balanced enables zerank-2)', async () => {
    // balanced mode bundle has reranker_enabled: true + reranker_model:
    // 'zeroentropyai:zerank-2' baked in. Pre-fix this case returned
    // undefined; post-fix doctor sees what search actually uses.
    configureGateway({ env: {} });
    const engine = makeEngineStub({});
    const resolved = await resolveLiveRerankerModel(engine);
    expect(resolved).toBe('zeroentropyai:zerank-2');
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
    configureGateway({ env: { ZEROENTROPY_API_KEY: 'sk-test' } });
    const engine = {
      async getConfig(): Promise<string | null> {
        throw new Error('DB unreachable');
      },
    } as any;
    const resolved = await resolveLiveRerankerModel(engine);
    // balanced mode bundle is the safety fallback when search.mode is unset
    // (and here, every config read failed) — and balanced enables
    // zeroentropyai:zerank-2 by default.
    expect(resolved).toBe('zeroentropyai:zerank-2');
  });
});
