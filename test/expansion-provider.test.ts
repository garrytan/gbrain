/**
 * Tests for the pluggable expansion provider abstraction.
 * Mirrors the embedding-provider test pattern.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  getActiveExpansionProvider,
  isExpansionAvailable,
  resetActiveExpansionProvider,
} from '../src/core/expansion-provider.ts';

const originalEnv: Record<string, string | undefined> = {};
const PROVIDER_KEYS = [
  'GBRAIN_EXPANSION_PROVIDER',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
];

beforeEach(() => {
  for (const k of PROVIDER_KEYS) originalEnv[k] = process.env[k];
  resetActiveExpansionProvider();
});

afterEach(() => {
  for (const k of PROVIDER_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  resetActiveExpansionProvider();
});

describe('getActiveExpansionProvider', () => {
  it('defaults to AnthropicExpander when GBRAIN_EXPANSION_PROVIDER is unset', () => {
    delete process.env.GBRAIN_EXPANSION_PROVIDER;
    const provider = getActiveExpansionProvider();
    expect(provider.constructor.name).toBe('AnthropicExpander');
  });

  it('returns AnthropicExpander for GBRAIN_EXPANSION_PROVIDER=anthropic', () => {
    process.env.GBRAIN_EXPANSION_PROVIDER = 'anthropic';
    const provider = getActiveExpansionProvider();
    expect(provider.constructor.name).toBe('AnthropicExpander');
  });

  it('returns GeminiExpander for GBRAIN_EXPANSION_PROVIDER=gemini', () => {
    process.env.GBRAIN_EXPANSION_PROVIDER = 'gemini';
    const provider = getActiveExpansionProvider();
    expect(provider.constructor.name).toBe('GeminiExpander');
  });

  it('caches the provider across calls', () => {
    process.env.GBRAIN_EXPANSION_PROVIDER = 'anthropic';
    const a = getActiveExpansionProvider();
    const b = getActiveExpansionProvider();
    expect(a).toBe(b);
  });

  it('returns a new instance after resetActiveExpansionProvider', () => {
    process.env.GBRAIN_EXPANSION_PROVIDER = 'anthropic';
    const a = getActiveExpansionProvider();
    resetActiveExpansionProvider();
    const b = getActiveExpansionProvider();
    expect(a).not.toBe(b);
  });
});

describe('isExpansionAvailable', () => {
  it('returns true when ANTHROPIC_API_KEY is set (default provider)', () => {
    delete process.env.GBRAIN_EXPANSION_PROVIDER;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    expect(isExpansionAvailable()).toBe(true);
  });

  it('returns false when ANTHROPIC_API_KEY is absent (default provider)', () => {
    delete process.env.GBRAIN_EXPANSION_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    expect(isExpansionAvailable()).toBe(false);
  });

  it('returns true when GBRAIN_EXPANSION_PROVIDER=gemini and GOOGLE_API_KEY is set', () => {
    process.env.GBRAIN_EXPANSION_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'test-key';
    delete process.env.GEMINI_API_KEY;
    expect(isExpansionAvailable()).toBe(true);
  });

  it('returns true when GBRAIN_EXPANSION_PROVIDER=gemini and GEMINI_API_KEY is set', () => {
    process.env.GBRAIN_EXPANSION_PROVIDER = 'gemini';
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    expect(isExpansionAvailable()).toBe(true);
  });

  it('returns false when GBRAIN_EXPANSION_PROVIDER=gemini and no Gemini key is set', () => {
    process.env.GBRAIN_EXPANSION_PROVIDER = 'gemini';
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(isExpansionAvailable()).toBe(false);
  });
});

describe('GeminiExpander.expand', () => {
  it('throws with a clear message when no Gemini API key is set', async () => {
    process.env.GBRAIN_EXPANSION_PROVIDER = 'gemini';
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const provider = getActiveExpansionProvider();
    await expect(provider.expand('test query string')).rejects.toThrow(
      /GOOGLE_API_KEY|GEMINI_API_KEY/
    );
  });
});
