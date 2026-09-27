import { describe, expect, test } from 'bun:test';
import { synthesisSlug } from '../src/core/think/index.ts';

// persistSynthesis writes `synthesis/<stem>-<date>`. The stem used to keep
// only ASCII letters, so every non-Latin question on one day minted the same
// `synthesis/untitled-<date>` slug and the later page replaced the earlier one.
describe('synthesisSlug (#21)', () => {
  test('ASCII questions: punctuation becomes one hyphen, empty stem is untitled', () => {
    expect(synthesisSlug("What's the plan for Q3?", '2026-09-27')).toBe('synthesis/what-s-the-plan-for-q3-2026-09-27');
    expect(synthesisSlug('!!!', '2026-09-27')).toBe('synthesis/untitled-2026-09-27');
  });

  // #24: in-word punctuation is hyphenated (as slugifyText does), not dropped.
  test('in-word hyphens survive instead of gluing the words together', () => {
    expect(synthesisSlug('Что в телеграм-диалогах?', '2026-09-27')).toBe('synthesis/что-в-телеграм-диалогах-2026-09-27');
    expect(synthesisSlug('Send an e-mail', '2026-09-27')).toBe('synthesis/send-an-e-mail-2026-09-27');
  });

  test('non-Latin questions keep their letters, so two of them no longer collide', () => {
    const a = synthesisSlug('Что мы знаем про ёжиков?', '2026-09-27');
    const b = synthesisSlug('Какие риски у проекта?', '2026-09-27');
    expect(a).toBe('synthesis/что-мы-знаем-про-ёжиков-2026-09-27');
    expect(b).toBe('synthesis/какие-риски-у-проекта-2026-09-27');
  });

  test('accents fold and the 60 cap counts code points', () => {
    expect(synthesisSlug('Café plans', '2026-09-27')).toBe('synthesis/cafe-plans-2026-09-27');
    expect(synthesisSlug('\u{20000}'.repeat(70), '2026-09-27')).toBe(`synthesis/${'\u{20000}'.repeat(60)}-2026-09-27`);
  });
});
