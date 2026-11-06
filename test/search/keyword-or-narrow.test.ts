import { describe, expect, test } from 'bun:test';
import { commonOrTokens, narrowOrFallbackTokens, OR_FALLBACK_MATCH_CAP, type OrTokenShare } from '../../src/core/search/keyword-or-narrow.ts';

const t = (token: string, share: number | null, lexemes = 1): OrTokenShare => ({ token, lexemes, share });

describe('narrowOrFallbackTokens', () => {
  test('keeps the rarest tracked terms while their estimated matches fit the cap, and always the rarest one', () => {
    // 2M rows: kalomi ~2k, pricing ~8k (10k total), meeting ~400k.
    expect(narrowOrFallbackTokens([t('meeting', 0.2), t('kalomi', 0.001), t('pricing', 0.004)], 2_000_000)).toEqual(['kalomi', 'pricing']);
    expect(narrowOrFallbackTokens([t('meeting', 0.2), t('said', 0.3)], 2_000_000)).toEqual(['meeting']);
  });

  test('untracked terms (rare or absent) are always kept, next to the rarest tracked term', () => {
    expect(narrowOrFallbackTokens([t('zqxv', null), t('meeting', 0.2), t('said', 0.3)], 2_000_000)).toEqual(['zqxv', 'meeting']);
    expect(narrowOrFallbackTokens([t('zqxv', null), t('kalomi', 0.001), t('said', 0.3)], 2_000_000)).toEqual(['zqxv', 'kalomi']);
  });

  test('changes nothing when every term fits, when nothing is tracked, or on an empty table', () => {
    expect(narrowOrFallbackTokens([t('alpha', 0.001), t('beta', 0.002)], 2_000_000)).toBeNull();
    expect(narrowOrFallbackTokens([t('alpha', null), t('beta', null)], 2_000_000)).toBeNull();
    expect(narrowOrFallbackTokens([t('alpha', 0.5), t('beta', 0.5)], 0)).toBeNull();
  });

  test('stopwords (no lexeme) are dropped and never count as kept terms', () => {
    expect(narrowOrFallbackTokens([t('the', null, 0), t('meeting', 0.2), t('said', 0.3)], 2_000_000)).toEqual(['meeting']);
    expect(narrowOrFallbackTokens([t('the', null, 0), t('of', null, 0)], 2_000_000)).toBeNull();
  });

  test('the cap is a row count', () => {
    expect(narrowOrFallbackTokens([t('a1', 0.01), t('b2', 0.01)], OR_FALLBACK_MATCH_CAP * 100)).toEqual(['a1']);
    expect(narrowOrFallbackTokens([t('a1', 0.01), t('b2', 0.01)], OR_FALLBACK_MATCH_CAP * 50)).toBeNull();
  });
});

describe('commonOrTokens (#7491)', () => {
  const row = (token: string, share: number | null) => ({ token, lexemes: 1, share, rows: 2_000_000, analyzed: true });
  test('names the tracked tokens estimated past the cap; untracked tokens are never common', () => {
    expect([...commonOrTokens([row('say', 0.2), row('kalomi', 0.0001), row('412', null)], 400)]).toEqual(['say']);
  });
  test('no statistics, no common tokens', () => {
    expect(commonOrTokens([], 400).size).toBe(0);
  });
});
