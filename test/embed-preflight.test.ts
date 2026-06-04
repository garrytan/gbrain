/**
 * v0.41.6.0 D1 — embedding credential preflight.
 *
 * Pure-function tests; uses the gateway's configureGateway / resetGateway
 * test seam to drive different recipe / env shapes without touching
 * process.env.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import {
  validateEmbeddingCreds,
  formatEmbeddingCredsError,
  EmbeddingCredentialError,
} from '../src/core/embed-preflight.ts';
import type { AIGatewayConfig } from '../src/core/ai/types.ts';

// This file calls configureGateway() to drive credential-validation
// scenarios. configureGateway mutates module-level gateway state (_config).
// beforeEach resets BEFORE each test, but the LAST test leaves its config
// behind — and bun runs every file in a shard inside ONE process, so that
// residue (e.g. OPENAI_API_KEY: 'sk-test') bleeds into the next file's
// isAvailable('embedding') check. That's what made facts-backstop-gating
// fail intermittently (bin-pack-dependent) on CI shard 10. Clean up after
// the whole file so the gateway is pristine for whatever runs next.
afterAll(() => { resetGateway(); });

function baseConfig(overrides: Partial<AIGatewayConfig> = {}): AIGatewayConfig {
  return {
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1536,
    chat_model: 'anthropic:claude-sonnet-4-6',
    expansion_model: 'anthropic:claude-haiku-4-5',
    env: {},
    base_urls: {},
    ...overrides,
  };
}

describe('validateEmbeddingCreds', () => {
  beforeEach(() => { resetGateway(); });

  test('passes when OPENAI_API_KEY is present and openai model is configured', () => {
    configureGateway(baseConfig({ env: { OPENAI_API_KEY: 'sk-test' } }));
    expect(() => validateEmbeddingCreds()).not.toThrow();
  });

  test('throws EmbeddingCredentialError with reason=missing_env when OPENAI_API_KEY is unset', () => {
    configureGateway(baseConfig({ env: {} }));
    let caught: unknown;
    try { validateEmbeddingCreds(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EmbeddingCredentialError);
    const e = caught as EmbeddingCredentialError;
    expect(e.diagnosis.ok).toBe(false);
    if (!e.diagnosis.ok) {
      expect(e.diagnosis.reason).toBe('missing_env');
      if (e.diagnosis.reason === 'missing_env') {
        expect(e.diagnosis.missingEnvVars).toEqual(['OPENAI_API_KEY']);
        expect(e.diagnosis.provider).toBe('openai');
      }
    }
  });

  test('throws missing_env for voyage when VOYAGE_API_KEY is unset', () => {
    configureGateway(baseConfig({ embedding_model: 'voyage:voyage-3-large', env: {} }));
    let caught: unknown;
    try { validateEmbeddingCreds(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EmbeddingCredentialError);
    const e = caught as EmbeddingCredentialError;
    if (!e.diagnosis.ok && e.diagnosis.reason === 'missing_env') {
      expect(e.diagnosis.missingEnvVars).toEqual(['VOYAGE_API_KEY']);
      expect(e.diagnosis.provider).toBe('voyage');
    } else { expect('expected missing_env').toBe(JSON.stringify(e.diagnosis)); }
  });

  test('throws missing_env for google when GOOGLE_GENERATIVE_AI_API_KEY is unset', () => {
    configureGateway(baseConfig({ embedding_model: 'google:text-embedding-004', env: {} }));
    let caught: unknown;
    try { validateEmbeddingCreds(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EmbeddingCredentialError);
    const e = caught as EmbeddingCredentialError;
    if (!e.diagnosis.ok && e.diagnosis.reason === 'missing_env') {
      expect(e.diagnosis.missingEnvVars).toEqual(['GOOGLE_GENERATIVE_AI_API_KEY']);
    } else { expect('expected missing_env').toBe(JSON.stringify(e.diagnosis)); }
  });

  test('throws no_touchpoint when configured embedding_model points at anthropic', () => {
    configureGateway(baseConfig({
      embedding_model: 'anthropic:claude-3-5-sonnet',
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    }));
    let caught: unknown;
    try { validateEmbeddingCreds(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EmbeddingCredentialError);
    const e = caught as EmbeddingCredentialError;
    if (!e.diagnosis.ok) {
      expect(e.diagnosis.reason).toBe('no_touchpoint');
    }
  });

  test('throws unknown_provider when embedding_model uses unknown provider', () => {
    configureGateway(baseConfig({ embedding_model: 'fakeprovider:embed-1', env: {} }));
    let caught: unknown;
    try { validateEmbeddingCreds(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EmbeddingCredentialError);
    const e = caught as EmbeddingCredentialError;
    if (!e.diagnosis.ok) {
      expect(e.diagnosis.reason).toBe('unknown_provider');
    }
  });

  test('throws no_gateway_config when gateway was not configured', () => {
    // resetGateway() in beforeEach already cleared _config.
    let caught: unknown;
    try { validateEmbeddingCreds(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EmbeddingCredentialError);
    const e = caught as EmbeddingCredentialError;
    if (!e.diagnosis.ok) {
      expect(e.diagnosis.reason).toBe('no_gateway_config');
    }
  });
});

describe('formatEmbeddingCredsError', () => {
  beforeEach(() => { resetGateway(); });

  test('missing_env produces paste-ready hint naming the env var + --no-embed option', () => {
    configureGateway(baseConfig({ env: {} }));
    let e: EmbeddingCredentialError;
    try { validateEmbeddingCreds(); throw new Error('expected throw'); }
    catch (err) { e = err as EmbeddingCredentialError; }
    expect(e!.userMessage).toContain('OPENAI_API_KEY');
    expect(e!.userMessage).toContain('--no-embed');
    expect(e!.userMessage).toContain('export OPENAI_API_KEY');
  });

  test('openai-missing message suggests switching to voyage (not openai)', () => {
    configureGateway(baseConfig({ env: {} }));
    let e: EmbeddingCredentialError;
    try { validateEmbeddingCreds(); throw new Error('expected throw'); }
    catch (err) { e = err as EmbeddingCredentialError; }
    // Don't tell user to switch to the provider they already have.
    expect(e!.userMessage).toContain('voyage');
    expect(e!.userMessage).not.toMatch(/Switch providers:.*openai:/);
  });

  test('voyage-missing message suggests switching to openai', () => {
    configureGateway(baseConfig({ embedding_model: 'voyage:voyage-3-large', env: {} }));
    let e: EmbeddingCredentialError;
    try { validateEmbeddingCreds(); throw new Error('expected throw'); }
    catch (err) { e = err as EmbeddingCredentialError; }
    expect(e!.userMessage).toContain('VOYAGE_API_KEY');
    expect(e!.userMessage).toContain('openai:text-embedding-3-small');
  });

  test('no_model_configured returns empty-string for ok diagnosis', () => {
    configureGateway(baseConfig({ env: { OPENAI_API_KEY: 'sk-test' } }));
    expect(formatEmbeddingCredsError({
      ok: true, model: 'openai:text-embedding-3-small', provider: 'openai', recipeId: 'openai',
    })).toBe('');
  });
});
