// #4087 — thinking-by-default model detection must match Claude 5-family ids
// behind ANY provider-prefix chain (openrouter:anthropic/..., claude-cli:...,
// bare ids), and must NEVER match the 8192-capped claude-3-5 family (pushing
// the 32k thinking headroom onto those models 400s on Anthropic).
import { describe, expect, test } from 'bun:test';
import { isThinkingByDefaultModel } from '../../src/core/ai/gateway.ts';
import { maxOutputTokensFor } from '../../src/core/think/index.ts';

const POSITIVES = [
  'anthropic:claude-sonnet-5',
  'anthropic:claude-fable-5',
  'anthropic/claude-sonnet-5',
  'openrouter:anthropic/claude-sonnet-5',
  'openrouter:anthropic/claude-opus-5.5',
  'claude-sonnet-5',
  'claude-cli:claude-fable-5',
  'ANTHROPIC:CLAUDE-SONNET-5', // case-insensitive
];

const NEGATIVES = [
  'anthropic:claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'anthropic:claude-haiku-4-5-20251001',
  'openrouter:anthropic/claude-sonnet-4.6',
  // The 3.5 family: `claude-3-5-*` must not match — its hard output cap is
  // 8192 and the 32k default would be a request error, not free headroom.
  'anthropic:claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'openrouter:anthropic/claude-3-5-sonnet',
  'deepseek:deepseek-chat',
  'openai:gpt-5',
  'google:gemini-3-pro-preview',
  '',
];

describe('isThinkingByDefaultModel (#4087)', () => {
  for (const id of POSITIVES) {
    test(`matches ${id}`, () => {
      expect(isThinkingByDefaultModel(id)).toBe(true);
    });
  }
  for (const id of NEGATIVES) {
    test(`does not match ${JSON.stringify(id)}`, () => {
      expect(isThinkingByDefaultModel(id)).toBe(false);
    });
  }
  test('undefined is falsy', () => {
    expect(isThinkingByDefaultModel(undefined)).toBe(false);
  });
});

describe('think maxOutputTokensFor shares the detection', () => {
  test('provider-prefixed Claude 5 gets thinking headroom', () => {
    expect(maxOutputTokensFor('openrouter:anthropic/claude-sonnet-5')).toBe(16000);
  });
  test('claude-3-5 family keeps the conservative default', () => {
    expect(maxOutputTokensFor('anthropic:claude-3-5-sonnet-20241022')).toBe(4000);
  });
});
