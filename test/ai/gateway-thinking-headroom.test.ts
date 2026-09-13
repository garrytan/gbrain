import { describe, it, expect } from 'bun:test';
import {
  defaultMaxOutputTokens,
  isThinkingModel,
  DEFAULT_MAX_OUTPUT_TOKENS,
  THINKING_MODEL_MAX_OUTPUT_TOKENS,
  isThinkingByDefaultModel,
} from '../../src/core/ai/gateway.ts';
import { getProviderCapabilities } from '../../src/core/ai/capabilities.ts';

// gbrain#4172: reasoning bills as output and counts against max_tokens. A
// thinking-by-default model handed the 4096 non-thinking default spends the
// whole budget reasoning and returns empty content with finish_reason
// "length", so callers relying on the default see truncated or blank output.
// `think`'s maxOutputTokensFor keys this off the recipe capability already;
// these tests pin the same behavior for the gateway's chat() default.
describe('defaultMaxOutputTokens: recipe-declared thinking headroom (#4172)', () => {
  it('grants headroom to DeepSeek v4, which declares thinking_by_default', () => {
    // Guard the premise: if the recipe ever drops the flag, fail here rather
    // than silently reverting to the 4096 default at runtime.
    expect(getProviderCapabilities('deepseek:deepseek-v4-flash').supportsThinking).toBe(true);
    expect(isThinkingModel('deepseek:deepseek-v4-flash')).toBe(true);
    expect(defaultMaxOutputTokens('deepseek:deepseek-v4-flash')).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
    expect(defaultMaxOutputTokens('deepseek:deepseek-v4-pro')).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
  });

  it('still grants headroom to name-matched Claude 5 models (regex path intact)', () => {
    expect(isThinkingByDefaultModel('anthropic:claude-sonnet-5')).toBe(true);
    expect(isThinkingModel('anthropic:claude-sonnet-5')).toBe(true);
    expect(defaultMaxOutputTokens('anthropic:claude-sonnet-5')).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
  });

  it('keeps the conservative default for non-thinking models', () => {
    expect(getProviderCapabilities('groq:qwen/qwen3.8-27b').supportsThinking).toBe(false);
    expect(isThinkingModel('groq:qwen/qwen3.8-27b')).toBe(false);
    expect(defaultMaxOutputTokens('groq:qwen/qwen3.8-27b')).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it('degrades to the default for unknown providers instead of throwing', () => {
    // getProviderCapabilities throws for unknown/chat-less recipes; the sizer
    // must swallow that rather than take down every chat() call.
    expect(() => defaultMaxOutputTokens('not-a-provider:not-a-model')).not.toThrow();
    expect(isThinkingModel('not-a-provider:not-a-model')).toBe(false);
    expect(defaultMaxOutputTokens('not-a-provider:not-a-model')).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(defaultMaxOutputTokens(undefined)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});
