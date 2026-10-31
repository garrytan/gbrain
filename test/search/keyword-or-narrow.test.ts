import { describe, expect, test } from 'bun:test';
import { narrowOrFallbackTokens, narrowedOrFallbackQuery, OR_FALLBACK_MATCH_CAP, type OrTokenShare } from '../../src/core/search/keyword-or-narrow.ts';

const t = (token: string, share: number | null, lexemes = 1): OrTokenShare => ({ token, lexemes, share });

describe('narrowOrFallbackTokens', () => {
  // #7899: short-query tests never exercised a long untracked vocabulary.
  // These protect the retry's width, not a guessed latency; no new seam needed.
  test('bounds 78 untracked terms plus a tracked anchor even when the row cap does not bind', () => {
    const unknown = Array.from({ length: 78 }, (_, i) => t(`longtail${i}`, null));
    const tokens = [t('service', 1), t('invoice', 1), t('rare', 0.3), ...unknown];
    expect(narrowOrFallbackTokens(tokens, 6500)).toEqual([...unknown.slice(0, 15).map(t => t.token), 'rare']);
    expect(narrowOrFallbackTokens(tokens, 6500, 2000)).toEqual([...unknown.slice(0, 15).map(t => t.token), 'rare']);
  });

  test('bounds all-untracked terms, ignores duplicates and preserves stable input order', () => {
    const tokens = Array.from({ length: 81 }, (_, i) => t(`longtail${i}`, null));
    expect(narrowOrFallbackTokens(tokens, 6500)).toEqual(tokens.slice(0, 16).map(t => t.token));
    expect(narrowOrFallbackTokens(tokens.flatMap(t => [t, t]), 6500)).toEqual(tokens.slice(0, 16).map(t => t.token));
    expect(narrowOrFallbackTokens(Array(80).fill(t('alpha', null)), 6500)).toBeNull();
  });

  test('also bounds many cheap tracked terms without changing the row cap', () => {
    const tokens = Array.from({ length: 81 }, (_, i) => t(`tracked${i}`, 0.00001 * (81 - i)));
    expect(narrowOrFallbackTokens(tokens, 6500)).toEqual(tokens.slice(-16).reverse().map(t => t.token));
  });

  test('the SQL-reader boundary narrows long questions but retains statistics failure fallback', async () => {
    const tokens = Array.from({ length: 81 }, (_, i) => t(`longtail${i}`, null));
    const query = tokens.map(t => t.token).join(' ');
    const read = async () => tokens.map(t => ({ ...t, rows: 6500, analyzed: true }));
    expect(await narrowedOrFallbackQuery(read, query, 'english')).toBe(tokens.slice(0, 16).map(t => t.token).join(' OR '));
    expect(await narrowedOrFallbackQuery(async () => { throw new Error('statistics unavailable'); }, query, 'english')).toBeNull();
    expect(await narrowedOrFallbackQuery(async () => (await read()).map(t => ({ ...t, analyzed: false })), query, 'english')).toBeNull();
  });
  test('keeps the rarest tracked terms while their estimated matches fit the cap, and always the rarest one', () => {
    // 2M rows: kalomi ~2k, pricing ~8k (10k total), meeting ~400k.
    expect(narrowOrFallbackTokens([t('meeting', 0.2), t('kalomi', 0.001), t('pricing', 0.004)], 2_000_000)).toEqual(['kalomi', 'pricing']);
    expect(narrowOrFallbackTokens([t('meeting', 0.2), t('said', 0.3)], 2_000_000)).toEqual(['meeting']);
  });

  test('short untracked sets (rare or absent) are kept next to the rarest tracked term', () => {
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
