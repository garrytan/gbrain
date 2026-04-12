import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ORIGINAL_ENV = { ...process.env };
let tempHome: string;

async function loadConfigModule() {
  return import(`../src/core/config.ts?test=${Date.now()}-${Math.random()}`);
}

describe('embedding provider config', () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'gbrain-config-'));
    process.env.HOME = tempHome;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_DATABASE_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('infers Gemini provider from GEMINI_API_KEY env', async () => {
    process.env.GBRAIN_DATABASE_URL = 'postgresql://example';
    process.env.GEMINI_API_KEY = 'gemini-test-key';

    const { loadConfig } = await loadConfigModule();
    const config = loadConfig();

    expect(config?.embedding_provider).toBe('gemini');
    expect(config?.gemini_api_key).toBe('gemini-test-key');
  });

  test('respects explicit provider and model env overrides', async () => {
    process.env.GBRAIN_DATABASE_URL = 'postgresql://example';
    process.env.OPENAI_API_KEY = 'openai-test-key';
    process.env.GEMINI_API_KEY = 'gemini-test-key';
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    process.env.GBRAIN_EMBEDDING_MODEL = 'gemini-embedding-custom';

    const { loadConfig } = await loadConfigModule();
    const config = loadConfig();

    expect(config?.embedding_provider).toBe('gemini');
    expect(config?.embedding_model).toBe('gemini-embedding-custom');
    expect(config?.openai_api_key).toBe('openai-test-key');
    expect(config?.gemini_api_key).toBe('gemini-test-key');
  });

});
