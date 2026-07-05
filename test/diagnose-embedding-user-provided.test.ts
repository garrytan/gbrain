/**
 * Regression: diagnoseEmbedding must accept an EXPLICIT model on
 * user-provided-models recipes (litellm, llama-server, ...).
 *
 * The removed `user_provided_model_unset` guard fired on recipe-STATIC
 * properties (`models: []` + `user_provided_models: true`) without ever
 * inspecting the user's model string. A fully explicit `litellm:zembed-1`
 * was misdiagnosed as "model unset", `isAvailable('embedding')` returned
 * false, and hybridSearch silently dropped its vector arm on every
 * litellm-proxied deployment — while embed-backfill (which skips this
 * preflight) kept writing vectors nobody could ever retrieve.
 *
 * A genuinely missing model part cannot reach that guard: parseModelId()
 * throws on bare `litellm` and on `litellm:` (empty model id), which
 * diagnoseEmbedding surfaces as `unknown_provider` with the format hint.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  diagnoseEmbedding,
  isAvailable,
  resetGateway,
} from '../src/core/ai/gateway.ts';

beforeEach(() => {
  resetGateway();
});

afterEach(() => {
  resetGateway();
});

describe('diagnoseEmbedding on user-provided-models recipes', () => {
  test('explicit litellm:<model> is ok (auth optional)', () => {
    configureGateway({
      embedding_model: 'litellm:zembed-1',
      embedding_dimensions: 1280,
      env: { LITELLM_BASE_URL: 'http://gateway.internal', LITELLM_API_KEY: 'token' },
    });
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.recipeId).toBe('litellm');
      expect(d.model).toBe('litellm:zembed-1');
    }
    expect(isAvailable('embedding')).toBe(true);
  });

  test('explicit litellm:<model> is ok even without optional env', () => {
    // LITELLM_* are optional (unauthenticated local proxy is a supported
    // shape); availability must not depend on them.
    configureGateway({ embedding_model: 'litellm:zembed-1', env: {} });
    expect(diagnoseEmbedding().ok).toBe(true);
  });

  test('explicit llama-server:<model> is ok', () => {
    configureGateway({
      embedding_model: 'llama-server:zembed-1-gguf',
      env: {},
    });
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.recipeId).toBe('llama-server');
  });

  test('modelOverride litellm:<model> probes ok on a foreign default', () => {
    // v0.36 (D10) column-override path: global default may be another
    // provider entirely; the override's recipe is what gets probed.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      env: {},
    });
    expect(isAvailable('embedding', 'litellm:zembed-1')).toBe(true);
  });

  test('bare provider (no model part) surfaces as unknown_provider with format hint', () => {
    configureGateway({ embedding_model: 'litellm', env: {} });
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe('unknown_provider');
      if (d.reason === 'unknown_provider') {
        expect(d.message).toContain('provider');
      }
    }
  });

  test('empty model part (litellm:) surfaces as unknown_provider', () => {
    configureGateway({ embedding_model: 'litellm:', env: {} });
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('unknown_provider');
  });

  test('missing_env still fires for recipes with required auth', () => {
    // Ordering guard: removing the unset-check must not skip the env check.
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', env: {} });
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe('missing_env');
      if (d.reason === 'missing_env') {
        expect(d.missingEnvVars).toContain('OPENAI_API_KEY');
      }
    }
  });
});
