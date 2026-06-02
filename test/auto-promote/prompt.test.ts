import { describe, it, expect } from 'bun:test';
import { buildPromotionReviewPrompt, PROMPT_VERSION } from '../../src/core/auto-promote/prompt.ts';

describe('buildPromotionReviewPrompt', () => {
  it('includes the candidate, context, and a strict JSON-only instruction', () => {
    const p = buildPromotionReviewPrompt({
      candidate_content: 'Acme raised a seed round.',
      target_ref: 'brain/companies/acme',
      target_context: '# Acme\n...',
      source_refs: ['user:msg:1'],
    });
    expect(p).toContain('Acme raised a seed round.');
    expect(p).toContain('brain/companies/acme');
    expect(p).toContain('"decision"');
    expect(p).toContain('JSON');
  });
  it('exposes a stable PROMPT_VERSION', () => {
    expect(typeof PROMPT_VERSION).toBe('string');
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});
