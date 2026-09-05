import { describe, it, expect } from 'bun:test';
import { resolveSynthMaxOutputTokens } from '../src/core/cycle/synthesize-concepts.ts';
import { getProviderCapabilities } from '../src/core/ai/capabilities.ts';

// Minimal engine stub: only getConfig is consulted by the resolver.
const engineWith = (cfg: Record<string, string>) =>
  ({ getConfig: async (k: string) => cfg[k] }) as any;

// synthesize_concepts resolves its model at `tier: 'reasoning'`, yet capped the
// narrative call at a hardcoded 500 output tokens. Reasoning bills as output and
// counts against max_tokens, so a thinking-by-default model spends the budget
// before emitting answer text, returns empty content with finish_reason
// "length", and the phase silently falls back to `deterministicNarrative` —
// shipping a template stub as if synthesis had succeeded.
describe('resolveSynthMaxOutputTokens', () => {
  it('grants reasoning headroom to a thinking-by-default model', async () => {
    // Guard the premise: if the recipe drops the flag this fails here, loudly.
    expect(getProviderCapabilities('deepseek:deepseek-v4-flash').supportsThinking).toBe(true);
    expect(await resolveSynthMaxOutputTokens(engineWith({}), 'deepseek:deepseek-v4-flash'))
      .toBe(8000);
  });

  it('keeps the 500 default for a non-thinking model', async () => {
    expect(getProviderCapabilities('groq:qwen/qwen3.8-27b').supportsThinking).toBe(false);
    expect(await resolveSynthMaxOutputTokens(engineWith({}), 'groq:qwen/qwen3.8-27b'))
      .toBe(500);
  });

  it('lets explicit operator config win over both defaults', async () => {
    const cfg = { 'cycle.synthesize_concepts.max_output_tokens': '1200' };
    expect(await resolveSynthMaxOutputTokens(engineWith(cfg), 'groq:qwen/qwen3.8-27b')).toBe(1200);
    expect(await resolveSynthMaxOutputTokens(engineWith(cfg), 'deepseek:deepseek-v4-flash')).toBe(1200);
  });

  it('ignores config below the floor that would truncate every response', async () => {
    const cfg = { 'cycle.synthesize_concepts.max_output_tokens': '32' };
    expect(await resolveSynthMaxOutputTokens(engineWith(cfg), 'groq:qwen/qwen3.8-27b')).toBe(500);
  });

  it('degrades to the default for an unknown provider instead of throwing', async () => {
    expect(await resolveSynthMaxOutputTokens(engineWith({}), 'not-a-provider:nope')).toBe(500);
  });
});
