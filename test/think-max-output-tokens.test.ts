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
    // Prefix must be the openai provider — a bare model name or another
    // provider's gpt-5 spelling doesn't match.
    expect(maxOutputTokensFor('o3')).toBe(4000);
    expect(maxOutputTokensFor('gpt-5.2')).toBe(4000);
    expect(maxOutputTokensFor('openrouter:openai/gpt-5.2')).toBe(4000);
  });

  test('gbrain#4172 — recipe-declared thinking-by-default models (DeepSeek v4) get 16000 via the capability layer', () => {
    // DeepSeek v4 thinks by default and bills reasoning against max_tokens:
    // at 4000 the whole budget is spent reasoning and think returns
    // truncated/empty JSON. Keyed on thinking_by_default (capability), not a
    // model-name regex, so provider renames keep the headroom.
    expect(maxOutputTokensFor('deepseek:deepseek-v4-flash')).toBe(16000);
    expect(maxOutputTokensFor('deepseek:deepseek-v4-pro')).toBe(16000);
    // Retired alias still routes to a thinking v4 model at the provider.
    expect(maxOutputTokensFor('deepseek:deepseek-reasoner')).toBe(16000);
    // Recipes without the capability keep the conservative default.
    expect(maxOutputTokensFor('ollama:llama3.3')).toBe(4000);
    expect(maxOutputTokensFor('groq:llama-3.3-70b-versatile')).toBe(4000);
    // Unknown provider strings fail open to the default, never throw.
    expect(maxOutputTokensFor('nonexistent-provider:whatever')).toBe(4000);
    expect(maxOutputTokensFor('voyage:voyage-4')).toBe(4000); // chat-less recipe
  });
});
