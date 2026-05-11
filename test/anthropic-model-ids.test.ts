import { describe, it, expect } from 'bun:test';
import { anthropic } from '../src/core/ai/recipes/anthropic.ts';

describe('Anthropic recipe model IDs', () => {
  it('chat models use canonical Anthropic API IDs (no phantom dates)', () => {
    const chatModels = anthropic.touchpoints?.chat?.models ?? [];
    // claude-sonnet-4-6 is the correct API ID per Anthropic docs.
    // The dated form claude-sonnet-4-6-20250929 returns 404 on the API.
    expect(chatModels).toContain('claude-sonnet-4-6');
    expect(chatModels).not.toContain('claude-sonnet-4-6-20250929');
  });

  it('expansion models use canonical IDs', () => {
    const expansionModels = anthropic.touchpoints?.expansion?.models ?? [];
    expect(expansionModels).toContain('claude-sonnet-4-6');
    expect(expansionModels).not.toContain('claude-sonnet-4-6-20250929');
  });

  it('does not forward-alias dateless 4.6+ models (they ARE the canonical ID)', () => {
    // Starting with Claude 4.6, Anthropic API IDs are dateless and pinned.
    // No forward alias needed — the dateless form IS the model ID.
    expect(anthropic.aliases?.['claude-sonnet-4-6']).toBeUndefined();
    expect(anthropic.aliases?.['claude-opus-4-7']).toBeUndefined();
  });

  it('pre-4.6 models still have date-based aliases', () => {
    // Haiku 4.5 predates the dateless convention, keeps its alias
    expect(anthropic.aliases?.['claude-haiku-4-5']).toBe('claude-haiku-4-5-20251001');
  });

  it('reverse-alias rescues stale broken Sonnet 4.6 ID', () => {
    // v0.31.6 shipped 'claude-sonnet-4-6-20250929' as a hardcoded default.
    // Users with stale config (models.dream.synthesize, facts.extraction_model)
    // must keep working — the reverse alias rewrites broken → canonical.
    expect(anthropic.aliases?.['claude-sonnet-4-6-20250929']).toBe('claude-sonnet-4-6');
  });

  it('all listed models follow naming conventions', () => {
    const allModels = [
      ...(anthropic.touchpoints?.chat?.models ?? []),
      ...(anthropic.touchpoints?.expansion?.models ?? []),
    ];
    for (const m of allModels) {
      // No model should contain a date that doesn't exist on the Anthropic API
      expect(m).not.toMatch(/claude-sonnet-4-6-\d{8}/);
    }
  });
});
