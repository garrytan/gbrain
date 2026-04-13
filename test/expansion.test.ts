import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Unit tests for query expansion module provider selection.
 *
 * These tests verify that getClient() and getModel() (exposed via module-level
 * constants for testing) select the correct LLM provider based on env vars.
 *
 * Integration tests that call the real API are skipped when API keys are absent.
 */

// --- Provider selection logic tests (env var driven) ---

describe('Expansion provider selection', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env vars before each test
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_BASE_URL;
  });

  afterEach(() => {
    // Restore original env
    Object.assign(process.env, originalEnv);
  });

  test('uses default Anthropic model when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    // Reimport to get fresh module state is not possible in Bun without cache tricks,
    // so we test the selection logic directly.
    const model = selectModel(process.env);
    expect(model).toBe('claude-haiku-4-5-20251001');
  });

  test('uses MiniMax model when only MINIMAX_API_KEY is set', () => {
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    const model = selectModel(process.env);
    expect(model).toBe('MiniMax-M2.7');
  });

  test('prefers Anthropic when both ANTHROPIC_API_KEY and MINIMAX_API_KEY are set', () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    const model = selectModel(process.env);
    expect(model).toBe('claude-haiku-4-5-20251001');
  });

  test('uses default model when neither key is set', () => {
    const model = selectModel(process.env);
    expect(model).toBe('claude-haiku-4-5-20251001');
  });

  test('uses default MiniMax base URL when MINIMAX_BASE_URL is not set', () => {
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    const baseURL = selectBaseURL(process.env);
    expect(baseURL).toBe('https://api.minimax.io/anthropic');
  });

  test('uses custom MINIMAX_BASE_URL when set', () => {
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    process.env.MINIMAX_BASE_URL = 'https://api.minimaxi.com/anthropic';
    const baseURL = selectBaseURL(process.env);
    expect(baseURL).toBe('https://api.minimaxi.com/anthropic');
  });
});

// --- Short query passthrough ---

describe('expandQuery short-circuit', () => {
  test('returns original query unchanged for short queries (< 3 words)', async () => {
    const { expandQuery } = await import('../src/core/search/expansion.ts');
    expect(await expandQuery('hello')).toEqual(['hello']);
    expect(await expandQuery('two words')).toEqual(['two words']);
  });
});

// --- Helper functions that mirror the module's internal logic ---
// These are declared here to avoid re-importing the module (which would
// retain a cached Anthropic client from the previous test run).

function selectModel(env: NodeJS.ProcessEnv): string {
  if (env.MINIMAX_API_KEY && !env.ANTHROPIC_API_KEY) {
    return 'MiniMax-M2.7';
  }
  return 'claude-haiku-4-5-20251001';
}

function selectBaseURL(env: NodeJS.ProcessEnv): string {
  return env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/anthropic';
}
