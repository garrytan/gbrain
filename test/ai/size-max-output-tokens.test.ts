import { describe, it, expect } from 'bun:test';
import {
  sizeMaxOutputTokens,
  defaultMaxOutputTokens,
  isThinkingModel,
  DEFAULT_MAX_OUTPUT_TOKENS,
  THINKING_MODEL_MAX_OUTPUT_TOKENS,
} from '../../src/core/ai/gateway.ts';
import { resolveSynthMaxOutputTokens } from '../../src/core/cycle/synthesize-concepts.ts';

const THINKING = 'deepseek:deepseek-v4-flash';
const PLAIN = 'groq:qwen/qwen3.8-27b';

describe('sizeMaxOutputTokens', () => {
  it('preserves the caller’s answer budget for a non-thinking model', () => {
    expect(isThinkingModel(PLAIN)).toBe(false);
    // Per-call budgets stay intentional: a 16-token intent probe stays 16.
    expect(sizeMaxOutputTokens(PLAIN, 16)).toBe(16);
    expect(sizeMaxOutputTokens(PLAIN, 400)).toBe(400);
    expect(sizeMaxOutputTokens(PLAIN, 500)).toBe(500);
  });

  it('gives a thinking model the shared cap regardless of answer budget', () => {
    expect(isThinkingModel(THINKING)).toBe(true);
    for (const answer of [16, 200, 400, 500, 4096]) {
      expect(sizeMaxOutputTokens(THINKING, answer)).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
    }
  });

  it('treats an unknown provider as non-thinking rather than throwing', () => {
    expect(() => sizeMaxOutputTokens('not-a-provider:nope', 400)).not.toThrow();
    expect(sizeMaxOutputTokens('not-a-provider:nope', 400)).toBe(400);
    expect(sizeMaxOutputTokens(undefined, 400)).toBe(400);
  });
});

// The helper is a generalization of two sizers that already shipped. These pin
// that collapsing them onto it changed no behavior.
describe('existing sizers are unchanged by the refactor', () => {
  it('defaultMaxOutputTokens still returns the gateway defaults', () => {
    expect(defaultMaxOutputTokens(PLAIN)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(defaultMaxOutputTokens(THINKING)).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
    expect(defaultMaxOutputTokens(undefined)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it('resolveSynthMaxOutputTokens still returns 500 / the shared cap', () => {
    expect(resolveSynthMaxOutputTokens(PLAIN)).toBe(500);
    expect(resolveSynthMaxOutputTokens(THINKING)).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
  });
});
