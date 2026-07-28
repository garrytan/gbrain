import { describe, test, expect } from 'bun:test';
import { openAiCompatV1Hint } from '../src/commands/models.ts';

/**
 * `gbrain models doctor` — the openai-compatible-proxy `/v1`-suffix hint.
 *
 * `openAiCompatV1Hint` is pure: it resolves the model's recipe synchronously
 * (no network, no engine) to decide whether the provider is an openai-compatible
 * proxy, then inspects the passed base URL. These cases pin the four branches
 * without any transport stub.
 */
describe('openAiCompatV1Hint', () => {
  test('openai-compat proxy without /v1 suffix returns a /v1 hint', () => {
    const hint = openAiCompatV1Hint('litellm:gpt-4o', 'http://localhost:4000');
    expect(hint).toBeDefined();
    expect(hint).toContain('/v1');
  });

  test('base URL already ending in /v1 returns undefined', () => {
    expect(openAiCompatV1Hint('litellm:gpt-4o', 'http://localhost:4000/v1')).toBeUndefined();
  });

  test('base URL ending in /v1/ (trailing slash) returns undefined', () => {
    expect(openAiCompatV1Hint('litellm:gpt-4o', 'http://localhost:4000/v1/')).toBeUndefined();
  });

  test('native anthropic provider returns undefined', () => {
    expect(openAiCompatV1Hint('anthropic:claude-sonnet-4-6', 'https://api.anthropic.com')).toBeUndefined();
  });

  test('native openai provider returns undefined', () => {
    expect(openAiCompatV1Hint('openai:gpt-4o', 'https://api.openai.com')).toBeUndefined();
  });

  test('missing base URL returns undefined', () => {
    expect(openAiCompatV1Hint('litellm:gpt-4o', undefined)).toBeUndefined();
    expect(openAiCompatV1Hint('litellm:gpt-4o', null)).toBeUndefined();
    expect(openAiCompatV1Hint('litellm:gpt-4o', '')).toBeUndefined();
  });
});
