/**
 * #2479 — think pipeline fixes:
 *  1. The synthesis prompt's Conflicts rule covers page-vs-page (and
 *     page-vs-take) disagreements, not just take-vs-take — pages-only brains
 *     surfaced zero conflicts before.
 *  2. Retrieval breadth / output-cap env knobs (GBRAIN_THINK_GATHER_LIMIT,
 *     GBRAIN_THINK_EXCERPT_LEN, GBRAIN_THINK_MAX_OUTPUT_TOKENS) tune
 *     conflict/variant recall per-install without changing defaults.
 */
import { describe, test, expect } from 'bun:test';
import { THINK_SYSTEM_PROMPT_BASE } from '../src/core/think/prompt.ts';
import { renderPagesBlock, envInt } from '../src/core/think/gather.ts';
import { maxOutputTokensFor } from '../src/core/think/index.ts';
import { withEnv } from './helpers/with-env.ts';

describe('think prompt — conflicts across pages AND takes (#2479)', () => {
  test('Conflicts rule covers pages and/or takes, with severity tags', () => {
    expect(THINK_SYSTEM_PROMPT_BASE).toContain('pages and/or takes');
    expect(THINK_SYSTEM_PROMPT_BASE).toContain('[HIGH]');
    expect(THINK_SYSTEM_PROMPT_BASE).toContain('VARIANTS');
  });

  test('example slugs are generic placeholders (privacy rule)', () => {
    expect(THINK_SYSTEM_PROMPT_BASE).toContain('finance/acme-pricing');
    expect(THINK_SYSTEM_PROMPT_BASE).not.toMatch(/velox|warm_dm/i);
  });
});

describe('think env knobs (#2479)', () => {
  test('envInt: valid positive int wins, garbage/absent falls back', async () => {
    await withEnv({ GBRAIN_TEST_KNOB: '7' }, () => {
      expect(envInt('GBRAIN_TEST_KNOB', 40)).toBe(7);
    });
    await withEnv({ GBRAIN_TEST_KNOB: 'banana' }, () => {
      expect(envInt('GBRAIN_TEST_KNOB', 40)).toBe(40);
    });
    await withEnv({ GBRAIN_TEST_KNOB: '-3' }, () => {
      expect(envInt('GBRAIN_TEST_KNOB', 40)).toBe(40);
    });
    expect(envInt('GBRAIN_TEST_KNOB_UNSET', 40)).toBe(40);
  });

  test('renderPagesBlock excerpt length honors GBRAIN_THINK_EXCERPT_LEN', async () => {
    const pages = [
      { slug: 'notes/long', compiled_truth: 'x'.repeat(1000) },
    ] as unknown as Parameters<typeof renderPagesBlock>[0];

    // Default stays 600.
    const dflt = renderPagesBlock(pages);
    expect(dflt).toContain('x'.repeat(600));
    expect(dflt).not.toContain('x'.repeat(601));

    await withEnv({ GBRAIN_THINK_EXCERPT_LEN: '50' }, () => {
      const out = renderPagesBlock(pages);
      expect(out).toContain('x'.repeat(50));
      expect(out).not.toContain('x'.repeat(51));
    });
  });

  test('maxOutputTokensFor honors GBRAIN_THINK_MAX_OUTPUT_TOKENS', async () => {
    await withEnv({ GBRAIN_THINK_MAX_OUTPUT_TOKENS: '9000' }, () => {
      expect(maxOutputTokensFor('openai:gpt-4o')).toBe(9000);
      expect(maxOutputTokensFor('anthropic:claude-sonnet-5')).toBe(9000);
    });
    // Defaults unchanged without the env var.
    await withEnv({ GBRAIN_THINK_MAX_OUTPUT_TOKENS: undefined }, () => {
      expect(maxOutputTokensFor('openai:gpt-4o')).toBe(4000);
      expect(maxOutputTokensFor('anthropic:claude-sonnet-5')).toBe(16000);
    });
  });
});
