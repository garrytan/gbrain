/**
 * v0.48.2 — reranker readiness leaf (src/core/ai/reranker-readiness.ts).
 *
 * Pins:
 *  - the default voyage reranker is ready iff VOYAGE_API_KEY is in the
 *    caller-supplied env (never process.env);
 *  - unknown provider / provider without a reranker touchpoint / unlisted
 *    model → not ready, with a model-shaped fix;
 *  - never throws on garbage;
 *  - AGREEMENT with the gateway's `isAvailable('reranker', model)` across an
 *    env × model matrix — the drift guard between the two predicates.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { rerankerReadiness, describeRerankerFix } from '../../src/core/ai/reranker-readiness.ts';
import {
  DEFAULT_RERANKER_MODEL,
  NEW_INSTALL_DEFAULT_RERANKER_MODEL,
} from '../../src/core/ai/defaults.ts';
import { configureGateway, resetGateway, isAvailable } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';


afterAll(() => resetGateway());

describe('rerankerReadiness — default voyage model', () => {
  test('key present → ready, no fix', () => {
    const r = rerankerReadiness(DEFAULT_RERANKER_MODEL, { VOYAGE_API_KEY: 'pa-test' });
    expect(r.provider).toBe('voyage');
    expect(r.modelId).toBe('rerank-2.5');
    expect(r.recipeKnown).toBe(true);
    expect(r.hasTouchpoint).toBe(true);
    expect(r.modelListed).toBe(true);
    expect(r.requiredKey).toBe('VOYAGE_API_KEY');
    expect(r.keyPresent).toBe(true);
    expect(r.ready).toBe(true);
    expect(describeRerankerFix(r)).toBeNull();
  });

  test('key absent → not ready; fix names the key AND the disable command', () => {
    const r = rerankerReadiness(DEFAULT_RERANKER_MODEL, {});
    expect(r.keyPresent).toBe(false);
    expect(r.ready).toBe(false);
    const fix = describeRerankerFix(r)!;
    expect(fix).toContain('VOYAGE_API_KEY not set');
    expect(fix).toContain('export VOYAGE_API_KEY=');
    expect(fix).toContain('gbrain config set search.reranker.enabled false');
  });

  test('an empty-string key counts as absent (mirrors the gateway env check)', () => {
    const r = rerankerReadiness(DEFAULT_RERANKER_MODEL, { VOYAGE_API_KEY: '' });
    expect(r.keyPresent).toBe(false);
    expect(r.ready).toBe(false);
  });

  test('a base-URL override does not bypass the provider key requirement', () => {
    const readiness = rerankerReadiness(DEFAULT_RERANKER_MODEL, {}, {
      baseUrlOverrides: { voyage: 'http://127.0.0.1:8080/v1' },
    });
    expect(readiness.selfHosted).toBe(true);
    expect(readiness.keyPresent).toBe(false);
    expect(readiness.ready).toBe(false);
    expect(describeRerankerFix(readiness)).toContain('VOYAGE_API_KEY not set');
  });

  test('the lite sibling is listed and ready with the same key', () => {
    const r = rerankerReadiness('voyage:rerank-2.5-lite', { VOYAGE_API_KEY: 'pa-test' });
    expect(r.modelListed).toBe(true);
    expect(r.ready).toBe(true);
  });

  // #4938: readiness is the third consumer of the recipe allowlist (after
  // gateway.rerank() and `gbrain models doctor`). Pre-fix it reported
  // modelListed:false / ready:false for the rerank-3 pair, so `gbrain search
  // modes` told an operator their configured reranker would not run.
  test('the rerank-3 pair is listed and ready on the same key (#4938)', () => {
    for (const model of ['voyage:rerank-3', 'voyage:rerank-3-lite']) {
      const r = rerankerReadiness(model, { VOYAGE_API_KEY: 'pa-test' });
      expect(r.modelListed).toBe(true);
      expect(r.ready).toBe(true);
    }
  });
});

describe('rerankerReadiness — shape failures never throw', () => {
  test('unknown provider', () => {
    const r = rerankerReadiness('nope:model', { VOYAGE_API_KEY: 'x' });
    expect(r.recipeKnown).toBe(false);
    expect(r.ready).toBe(false);
    expect(describeRerankerFix(r)).toContain('not a known reranker');
  });

  test('provider without a reranker touchpoint (openai)', () => {
    const r = rerankerReadiness('openai:text-embedding-3-small', { OPENAI_API_KEY: 'x' });
    expect(r.recipeKnown).toBe(true);
    expect(r.hasTouchpoint).toBe(false);
    expect(r.ready).toBe(false);
  });

  test('unlisted model on a reranker provider', () => {
    const r = rerankerReadiness('voyage:rerank-99', { VOYAGE_API_KEY: 'x' });
    expect(r.hasTouchpoint).toBe(true);
    expect(r.modelListed).toBe(false);
    expect(r.ready).toBe(false);
  });

  test('a keyless local recipe needs no env key: requiredKey null, ready', () => {
    const rec = getRecipe('llama-server-reranker')!;
    const r = rerankerReadiness(`llama-server-reranker:${rec.touchpoints.reranker!.default_model}`, {});
    expect(r.requiredKey).toBeNull();
    expect(r.keyPresent).toBe(true);
    expect(r.ready).toBe(true);
  });

  test('garbage input (no provider:model shape)', () => {
    const r = rerankerReadiness('garbage', { VOYAGE_API_KEY: 'x' });
    expect(r.provider).toBe('');
    expect(r.recipeKnown).toBe(false);
    expect(r.ready).toBe(false);
    expect(typeof describeRerankerFix(r)).toBe('string');
  });
});

describe('rerankerReadiness agrees with gateway isAvailable("reranker", model)', () => {
  // isAvailable checks recipe + touchpoint + required env; it does not check
  // model allowlists, so the agreement statement is on exactly
  // those three flags. Any divergence here means one surface will lie.
  const MODELS = [
    DEFAULT_RERANKER_MODEL,
    'voyage:rerank-2.5-lite',
    'openai:text-embedding-3-small',
    'nope:model',
    // keyless local recipe (auth_env.required empty) + a resolveAuth recipe
    // without a reranker touchpoint — the branches where the predicates
    // could diverge.
    `llama-server-reranker:${getRecipe('llama-server-reranker')!.touchpoints.reranker!.default_model}`,
    'azure-openai:gpt-4o',
  ];
  const ENVS: Array<Record<string, string>> = [
    {},
    { VOYAGE_API_KEY: 'pa' },
    { OPENAI_API_KEY: 'fixture-openai-key' },
    { VOYAGE_API_KEY: 'pa', OPENAI_API_KEY: 'fixture-openai-key' },
  ];

  test('env × model matrix', () => {
    for (const env of ENVS) {
      configureGateway({ env });
      for (const m of MODELS) {
        const r = rerankerReadiness(m, env);
        expect(isAvailable('reranker', m)).toBe(r.recipeKnown && r.hasTouchpoint && r.keyPresent);
      }
    }
  });
});
