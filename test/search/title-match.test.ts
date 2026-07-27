/**
 * T2 — title-phrase matcher unit tests (retrieval-maxpool incident).
 *
 * Pins isTitlePhraseMatch: the incident query "Greek amphitheater" must match
 * the Mingtang title; generic single-word / stopword queries must NOT promote
 * arbitrary pages (Codex#10 precision guard).
 */

import { describe, test, expect } from 'bun:test';
import { isTitlePhraseMatch, tokenizeTitle, __test__ } from '../../src/core/search/title-match.ts';

describe('isTitlePhraseMatch — positive (the incident)', () => {
  const MINGTANG = 'The Mingtang (明堂) — Indoor Greek Amphitheater for Adversarial Debate';

  test('the exact incident query matches', () => {
    expect(isTitlePhraseMatch('Greek amphitheater', MINGTANG)).toBe(true);
  });
  test('case + whitespace insensitive', () => {
    expect(isTitlePhraseMatch('  greek   AMPHITHEATER ', MINGTANG)).toBe(true);
  });
  test('contiguous multi-token phrase inside a longer title', () => {
    expect(isTitlePhraseMatch('indoor greek amphitheater', MINGTANG)).toBe(true);
  });
  test('exact full-title match of a 1-word chosen name', () => {
    expect(isTitlePhraseMatch('Mingtang', 'Mingtang')).toBe(true);
  });
  test('exact full-title match with punctuation/stopwords normalized', () => {
    expect(isTitlePhraseMatch('the hall of light', 'The Hall of Light')).toBe(true);
  });
});

describe('isTitlePhraseMatch — negative (precision guard)', () => {
  const MINGTANG = 'The Mingtang — Indoor Greek Amphitheater';
  test('single generic content word does NOT match (would over-promote)', () => {
    // "greek" alone is 1 content token → below MIN_CONTENT_TOKENS, no boost.
    expect(isTitlePhraseMatch('greek', MINGTANG)).toBe(false);
  });
  test('single stopword does NOT match', () => {
    expect(isTitlePhraseMatch('the', MINGTANG)).toBe(false);
  });
  test('non-contiguous tokens do NOT match (phrase, not bag-of-words)', () => {
    // "greek" and "indoor" both present but not contiguous in query order.
    expect(isTitlePhraseMatch('amphitheater indoor', 'The Indoor X Greek Amphitheater')).toBe(false);
  });
  test('substring that is not a token boundary does NOT match', () => {
    // "art" must not match "Bartholomew".
    expect(isTitlePhraseMatch('art history', 'Bartholomew History Notes')).toBe(false);
  });
  test('empty query / empty title', () => {
    expect(isTitlePhraseMatch('', MINGTANG)).toBe(false);
    expect(isTitlePhraseMatch('greek amphitheater', '')).toBe(false);
  });
  test('two stopwords only do NOT match', () => {
    expect(isTitlePhraseMatch('the of', 'The Theory of Everything')).toBe(false);
  });
});

describe('tokenizeTitle', () => {
  test('splits on punctuation + whitespace, lowercases', () => {
    expect(tokenizeTitle('The Mingtang — Indoor Greek!')).toEqual(['the', 'mingtang', 'indoor', 'greek']);
  });
  test('keeps CJK runs as tokens', () => {
    expect(tokenizeTitle('明堂 hall')).toEqual(['明堂', 'hall']);
  });
  test('MIN_CONTENT_TOKENS is 2 (the precision floor)', () => {
    expect(__test__.MIN_CONTENT_TOKENS).toBe(2);
  });
});
