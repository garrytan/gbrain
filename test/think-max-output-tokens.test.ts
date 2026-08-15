/**
 * Pins `maxOutputTokensFor` — the per-model output-token budget `runThink`
 * passes to `client.create`. Thinking-by-default Claude 5 models
 * (`anthropic:claude-*-5`) and OpenAI reasoning models (gpt-5 family,
 * o-series) spend a large share of the budget on internal reasoning before
 * emitting an answer, so the 4000 default left `think` with empty/truncated
 * text. They get 16000; everything else stays 4000.
 */
import { describe, test, expect } from 'bun:test';
import { maxOutputTokensFor } from '../src/core/think/index.ts';

describe('maxOutputTokensFor — thinking-default headroom', () => {
  test('Claude 5 family gets 16000', () => {
    expect(maxOutputTokensFor('anthropic:claude-sonnet-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-opus-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-fable-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-haiku-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic/claude-sonnet-5')).toBe(16000); // slash form
  });

  test('OpenAI reasoning models (gpt-5 family, o-series) get 16000', () => {
    expect(maxOutputTokensFor('openai:gpt-5')).toBe(16000);
    expect(maxOutputTokensFor('openai:gpt-5.2')).toBe(16000);
    expect(maxOutputTokensFor('openai:gpt-5.5')).toBe(16000);
    expect(maxOutputTokensFor('openai:gpt-5-mini')).toBe(16000);
    expect(maxOutputTokensFor('openai:o1')).toBe(16000);
    expect(maxOutputTokensFor('openai:o3')).toBe(16000);
    expect(maxOutputTokensFor('openai:o4-mini')).toBe(16000);
    expect(maxOutputTokensFor('openai/gpt-5.2')).toBe(16000); // slash form
  });

  test('non-Claude-5 and non-reasoning models keep 4000', () => {
    expect(maxOutputTokensFor('anthropic:claude-opus-4-8')).toBe(4000);
    expect(maxOutputTokensFor('anthropic:claude-haiku-4-5')).toBe(4000);
    expect(maxOutputTokensFor('anthropic:claude-sonnet-4-6')).toBe(4000);
    expect(maxOutputTokensFor('anthropic:claude-3-haiku')).toBe(4000);
    expect(maxOutputTokensFor('openai:gpt-4o')).toBe(4000);
    expect(maxOutputTokensFor('openai:gpt-4o-mini')).toBe(4000);
    expect(maxOutputTokensFor('openai:gpt-4.1')).toBe(4000);
    // Non-reasoning ChatGPT snapshots of the gpt-5 family stay at 4000.
    expect(maxOutputTokensFor('openai:gpt-5-chat-latest')).toBe(4000);
    expect(maxOutputTokensFor('openai:gpt-5.2-chat-latest')).toBe(4000);
    // Scope is the gpt-5 family + numbered o-series only — other OpenAI
    // reasoning-capable ids (e.g. codex-mini-latest) keep the conservative
    // default until deliberately added.
    expect(maxOutputTokensFor('openai:codex-mini-latest')).toBe(4000);
    // Version/name boundaries: `gpt-50` and `o3foo` are not gpt-5 / o3.
    expect(maxOutputTokensFor('openai:gpt-50')).toBe(4000);
    expect(maxOutputTokensFor('openai:o3foo')).toBe(4000);
    // Other providers' reasoning models are out of scope here — the routed
    // provider recipe, not this budget, is what changes for them.
    expect(maxOutputTokensFor('deepseek:deepseek-reasoner')).toBe(4000);
    // Prefix must be the openai provider — a bare model name or another
    // provider's gpt-5 spelling doesn't match.
    expect(maxOutputTokensFor('o3')).toBe(4000);
    expect(maxOutputTokensFor('gpt-5.2')).toBe(4000);
    expect(maxOutputTokensFor('openrouter:openai/gpt-5.2')).toBe(4000);
  });
});
