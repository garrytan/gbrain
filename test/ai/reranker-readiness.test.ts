/**
 * v0.48.2 — reranker readiness leaf (src/core/ai/reranker-readiness.ts).
 *
 * Pins:
 *  - the default voyage reranker is ready iff VOYAGE_API_KEY is in the
 *    caller-supplied env (never process.env);
 *  - an explicit ZeroEntropy model is ready before the sunset and
 *    `sunsetPassed` on/after it (injected clock);
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
  LEGACY_DEFAULT_RERANKER_MODEL,
  NEW_INSTALL_DEFAULT_RERANKER_MODEL,
  ZEROENTROPY_SUNSET_DATE,
} from '../../src/core/ai/defaults.ts';
import { configureGateway, resetGateway, isAvailable } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

const BEFORE = new Date(Date.parse(`${ZEROENTROPY_SUNSET_DATE}T00:00:00Z`) - 1000);
const AFTER = new Date(Date.parse(`${ZEROENTROPY_SUNSET_DATE}T00:00:00Z`) + 86_400_000);

afterAll(() => resetGateway());

describe('rerankerReadiness — default voyage model', () => {
  test('key present → ready, no fix', () => {
    const r = rerankerReadiness(DEFAULT_RERANKER_MODEL, { VOYAGE_API_KEY: 'pa-test' }, { now: BEFORE });
    expect(r.provider).toBe('voyage');
    expect(r.modelId).toBe('rerank-2.5');
    expect(r.recipeKnown).toBe(true);
    expect(r.hasTouchpoint).toBe(true);
    expect(r.modelListed).toBe(true);
    expect(r.requiredKey).toBe('VOYAGE_API_KEY');
    expect(r.keyPresent).toBe(true);
    expect(r.sunset).toBeNull();
    expect(r.ready).toBe(true);
    expect(describeRerankerFix(r)).toBeNull();
  });

  test('key absent → not ready; fix names the key AND the disable command', () => {
    const r = rerankerReadiness(DEFAULT_RERANKER_MODEL, {}, { now: BEFORE });
    expect(r.keyPresent).toBe(false);
    expect(r.ready).toBe(false);
    const fix = describeRerankerFix(r)!;
    expect(fix).toContain('VOYAGE_API_KEY not set');
    expect(fix).toContain('export VOYAGE_API_KEY=');
    expect(fix).toContain('gbrain config set search.reranker.enabled false');
  });

  test('an empty-string key counts as absent (mirrors the gateway env check)', () => {
    const r = rerankerReadiness(DEFAULT_RERANKER_MODEL, { VOYAGE_API_KEY: '' }, { now: BEFORE });
    expect(r.keyPresent).toBe(false);
    expect(r.ready).toBe(false);
  });

  test('the lite sibling is listed and ready with the same key', () => {
    const r = rerankerReadiness('voyage:rerank-2.5-lite', { VOYAGE_API_KEY: 'pa-test' }, { now: BEFORE });
    expect(r.modelListed).toBe(true);
    expect(r.ready).toBe(true);
  });
});

describe('rerankerReadiness — explicit ZeroEntropy model + sunset clock', () => {
  test('before the sunset with a key → ready', () => {
    const r = rerankerReadiness(LEGACY_DEFAULT_RERANKER_MODEL, { ZEROENTROPY_API_KEY: 'zk' }, { now: BEFORE });
    expect(r.sunset?.date).toBe(ZEROENTROPY_SUNSET_DATE);
    expect(r.sunsetPassed).toBe(false);
    expect(r.ready).toBe(true);
  });

  test('on/after the sunset → sunsetPassed, not ready, fix is the switch command (even with a key)', () => {
    const r = rerankerReadiness(LEGACY_DEFAULT_RERANKER_MODEL, { ZEROENTROPY_API_KEY: 'zk' }, { now: AFTER });
    expect(r.sunsetPassed).toBe(true);
    expect(r.keyPresent).toBe(true);
    expect(r.ready).toBe(false);
    const fix = describeRerankerFix(r)!;
    expect(fix).toContain(ZEROENTROPY_SUNSET_DATE);
    expect(fix).toContain(`gbrain config set search.reranker.model ${NEW_INSTALL_DEFAULT_RERANKER_MODEL}`);
  });

  test('sunset outranks a missing key in the fix text (dead provider first)', () => {
    const r = rerankerReadiness(LEGACY_DEFAULT_RERANKER_MODEL, {}, { now: AFTER });
    expect(describeRerankerFix(r)).toContain('provider sunset');
  });

  test('a provider_base_urls override (self-hosted endpoint) lifts the sunset block, mirroring the gateway', () => {
    const r = rerankerReadiness(LEGACY_DEFAULT_RERANKER_MODEL, { ZEROENTROPY_API_KEY: 'zk' }, {
      now: AFTER,
      baseUrlOverrides: { zeroentropyai: 'http://127.0.0.1:8080/v1' },
    });
    expect(r.sunsetPassed).toBe(true);
    expect(r.selfHosted).toBe(true);
    expect(r.sunsetBlocks).toBe(false);
    expect(r.ready).toBe(true);
    expect(describeRerankerFix(r)).toBeNull();
    // Self-hosted but keyless → the fix talks about the KEY, not the sunset.
    const noKey = rerankerReadiness(LEGACY_DEFAULT_RERANKER_MODEL, {}, {
      now: AFTER,
      baseUrlOverrides: { zeroentropyai: 'http://127.0.0.1:8080/v1' },
    });
    expect(noKey.ready).toBe(false);
    expect(describeRerankerFix(noKey)).toContain('ZEROENTROPY_API_KEY not set');
    expect(describeRerankerFix(noKey)).not.toContain('provider sunset');
  });

  test('mixed-case / slash-form ZE ids are still recognized as sunsetting', () => {
    expect(rerankerReadiness('ZeroEntropyAI:zerank-2', { ZEROENTROPY_API_KEY: 'zk' }, { now: AFTER }).sunsetPassed).toBe(true);
    expect(rerankerReadiness('zeroentropyai/zerank-2', { ZEROENTROPY_API_KEY: 'zk' }, { now: AFTER }).sunsetPassed).toBe(true);
  });
});

describe('rerankerReadiness — shape failures never throw', () => {
  test('unknown provider', () => {
    const r = rerankerReadiness('nope:model', { VOYAGE_API_KEY: 'x' }, { now: BEFORE });
    expect(r.recipeKnown).toBe(false);
    expect(r.ready).toBe(false);
    expect(describeRerankerFix(r)).toContain('not a known reranker');
  });

  test('provider without a reranker touchpoint (openai)', () => {
    const r = rerankerReadiness('openai:text-embedding-3-small', { OPENAI_API_KEY: 'x' }, { now: BEFORE });
    expect(r.recipeKnown).toBe(true);
    expect(r.hasTouchpoint).toBe(false);
    expect(r.ready).toBe(false);
  });

  test('unlisted model on a reranker provider', () => {
    const r = rerankerReadiness('voyage:rerank-99', { VOYAGE_API_KEY: 'x' }, { now: BEFORE });
    expect(r.hasTouchpoint).toBe(true);
    expect(r.modelListed).toBe(false);
    expect(r.ready).toBe(false);
  });

  test('a keyless local recipe needs no env key: requiredKey null, ready', () => {
    const rec = getRecipe('llama-server-reranker')!;
    const r = rerankerReadiness(`llama-server-reranker:${rec.touchpoints.reranker!.default_model}`, {}, { now: BEFORE });
    expect(r.requiredKey).toBeNull();
    expect(r.keyPresent).toBe(true);
    expect(r.ready).toBe(true);
  });

  test('garbage input (no provider:model shape)', () => {
    const r = rerankerReadiness('garbage', { VOYAGE_API_KEY: 'x' }, { now: BEFORE });
    expect(r.provider).toBe('');
    expect(r.recipeKnown).toBe(false);
    expect(r.ready).toBe(false);
    expect(typeof describeRerankerFix(r)).toBe('string');
  });
});

describe('rerankerReadiness agrees with gateway isAvailable("reranker", model)', () => {
  // isAvailable checks recipe + touchpoint + required env; it does not check
  // model allowlists or sunsets, so the agreement statement is on exactly
  // those three flags. Any divergence here means one surface will lie.
  const MODELS = [
    DEFAULT_RERANKER_MODEL,
    'voyage:rerank-2.5-lite',
    LEGACY_DEFAULT_RERANKER_MODEL,
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
    { ZEROENTROPY_API_KEY: 'zk' },
    { VOYAGE_API_KEY: 'pa', ZEROENTROPY_API_KEY: 'zk' },
  ];

  test('after the sunset isAvailable (env-only) stays true while readiness blocks — the intended divergence', () => {
    configureGateway({ env: { ZEROENTROPY_API_KEY: 'zk' } });
    const r = rerankerReadiness(LEGACY_DEFAULT_RERANKER_MODEL, { ZEROENTROPY_API_KEY: 'zk' }, { now: AFTER });
    expect(isAvailable('reranker', LEGACY_DEFAULT_RERANKER_MODEL)).toBe(true);
    expect(r.ready).toBe(false);
    expect(r.sunsetBlocks).toBe(true);
  });

  test('env × model matrix', () => {
    for (const env of ENVS) {
      configureGateway({ env });
      for (const m of MODELS) {
        const r = rerankerReadiness(m, env, { now: BEFORE });
        expect(isAvailable('reranker', m)).toBe(r.recipeKnown && r.hasTouchpoint && r.keyPresent);
      }
    }
  });
});
