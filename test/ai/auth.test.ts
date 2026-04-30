import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { redactAuthResolution, resolveProviderAuth } from '../../src/core/ai/auth.ts';
import { configureGateway, isAvailable, resetGateway } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import type { AIGatewayConfig } from '../../src/core/ai/types.ts';

const openai = getRecipe('openai');
if (!openai) throw new Error('openai recipe missing');

describe('provider auth resolver', () => {
  let tempDir: string;
  let authPath: string;

  beforeEach(() => {
    resetGateway();
    tempDir = mkdtempSync(join(tmpdir(), 'gbrain-auth-'));
    mkdirSync(join(tempDir, '.openclaw'), { recursive: true });
    authPath = join(tempDir, '.openclaw', 'auth.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('env fallback remains highest priority even when openclaw auth is configured', () => {
    writeFileSync(authPath, JSON.stringify({ profiles: { 'openclaw-codex': { OPENAI_API_KEY: 'oc-secret' } } }));
    const resolution = resolveProviderAuth(openai, config({
      env: { OPENAI_API_KEY: 'env-secret' },
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
    }));
    expect(resolution.source).toBe('env');
    expect(resolution.value).toBe('env-secret');
  });

  test('missing openclaw profile reports missing without secret leakage', () => {
    const resolution = resolveProviderAuth(openai, config({
      env: {},
      provider_auth: { openai: { prefer: 'openclaw-codex', profile: 'missing', openclawAuthPath: authPath } },
    }));
    expect(resolution.source).toBe('missing');
    expect(resolution.isConfigured).toBe(false);
    expect(resolution.missingReason).toContain('missing');
  });

  test('selected openclaw profile provides credential source class', () => {
    writeFileSync(authPath, JSON.stringify({ profiles: { 'openclaw-codex': { OPENAI_API_KEY: 'oc-secret' } } }));
    const resolution = resolveProviderAuth(openai, config({
      env: {},
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
    }));
    expect(resolution.source).toBe('openclaw-codex');
    expect(resolution.credentialKey).toBe('OPENAI_API_KEY');
    expect(resolution.value).toBe('oc-secret');
  });

  test('redaction omits token values', () => {
    writeFileSync(authPath, JSON.stringify({ profiles: { 'openclaw-codex': { OPENAI_API_KEY: 'oc-secret' } } }));
    const resolution = resolveProviderAuth(openai, config({
      env: {},
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
    }));
    const redacted = redactAuthResolution(resolution);
    expect(JSON.stringify(redacted)).not.toContain('oc-secret');
    expect(redacted).toMatchObject({ source: 'openclaw-codex', credentialKey: 'OPENAI_API_KEY' });
  });

  test('gateway availability respects selected openclaw profile', () => {
    writeFileSync(authPath, JSON.stringify({ profiles: { 'openclaw-codex': { OPENAI_API_KEY: 'oc-secret' } } }));
    configureGateway(config({
      embedding_model: 'openai:text-embedding-3-large',
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
      env: {},
    }));
    expect(isAvailable('embedding')).toBe(true);
  });

  test('gateway availability is false when selected profile is missing', () => {
    configureGateway(config({
      embedding_model: 'openai:text-embedding-3-large',
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
      env: {},
    }));
    expect(isAvailable('embedding')).toBe(false);
  });

});

function config(overrides: Partial<AIGatewayConfig>): AIGatewayConfig {
  return {
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    expansion_model: 'anthropic:claude-haiku-4-5-20251001',
    env: {},
    ...overrides,
  };
}
