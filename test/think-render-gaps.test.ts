/**
 * Regression test for `shouldRenderGapsBlock` in `src/commands/think.ts`.
 *
 * The synthesis prompt instructs the model to include a "Gaps" section inside
 * the answer body. The CLI also renders a structured `## Gaps` block from the
 * `gaps[]` array. Rendering both prints "Gaps" twice. This pins the de-dup
 * rule: the structured block is suppressed when the answer body already
 * contains a Gaps heading.
 *
 * Hermetic, no DB, no API keys.
 */

import { describe, test, expect } from 'bun:test';
import { shouldRenderGapsBlock } from '../src/commands/think.ts';

describe('shouldRenderGapsBlock — duplicate Gaps suppression', () => {
  test('suppresses structured block when answer body already has a Gaps heading', () => {
    const answer = '## Answer\n\nSome text.\n\n## Gaps\n\n- missing X\n';
    expect(shouldRenderGapsBlock(answer, ['missing X'])).toBe(false);
  });

  test('renders structured block when answer body has no Gaps heading', () => {
    const answer = '## Answer\n\nSome text with no gaps section.';
    expect(shouldRenderGapsBlock(answer, ['missing X'])).toBe(true);
  });

  test('never renders when there are no gaps', () => {
    expect(shouldRenderGapsBlock('## Answer\n\nText.', [])).toBe(false);
    expect(shouldRenderGapsBlock('## Answer\n\n## Gaps\n- x', [])).toBe(false);
  });

  test('matches Gaps heading at any markdown level and case-insensitively', () => {
    expect(shouldRenderGapsBlock('# Gaps\n- x', ['x'])).toBe(false);
    expect(shouldRenderGapsBlock('### gaps\n- x', ['x'])).toBe(false);
    expect(shouldRenderGapsBlock('###### GAPS\n- x', ['x'])).toBe(false);
  });

  test('does not match the word "gaps" in prose (heading-anchored only)', () => {
    const answer = '## Answer\n\nThere are some gaps in the data, but no section.';
    expect(shouldRenderGapsBlock(answer, ['missing X'])).toBe(true);
  });
});
