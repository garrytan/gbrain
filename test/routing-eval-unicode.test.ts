/**
 * normalizeText must strip punctuation, not scripts.
 *
 * The old ASCII class `[^a-z0-9]` deleted every non-Latin character,
 * which broke routing eval in two directions:
 *   1. a non-English trigger normalized to '' and was dropped by the
 *      `length >= 3` filter in extractTriggerPhrases — its fixtures
 *      could never match, so every positive case reported `missed` and
 *      every negative case passed vacuously;
 *   2. a mixed trigger such as `"<email> 처리됨"` collapsed to the bare
 *      token `email`, which is a substring of any English intent that
 *      mentions email — a manufactured false positive.
 */

import { describe, test, expect } from 'bun:test';
import {
  normalizeText,
  extractTriggerPhrases,
  structuralRouteMatch,
} from '../src/core/routing-eval.ts';

describe('normalizeText', () => {
  test('punctuation still collapses to spaces', () => {
    expect(normalizeText("What's up?")).toBe('what s up');
    expect(normalizeText('  Hello, world!  ')).toBe('hello world');
  });

  test('non-Latin scripts survive', () => {
    expect(normalizeText('이번 주말 가족 나들이')).toBe('이번 주말 가족 나들이');
    expect(normalizeText('会議のメモ')).toBe('会議のメモ');
    expect(normalizeText('Café — RÉSUMÉ')).toBe('café résumé');
  });
});

describe('extractTriggerPhrases', () => {
  test('a non-English trigger is not dropped by the length filter', () => {
    expect(extractTriggerPhrases('가족 나들이 계획 짜줘')).toEqual([
      '가족 나들이 계획 짜줘',
    ]);
  });
});

describe('structuralRouteMatch', () => {
  const index = {
    skillPhrases: new Map([
      ['family-outing', extractTriggerPhrases('가족 나들이 계획 짜줘')],
      ['loop-completion', extractTriggerPhrases('"<email> 처리됨"')],
    ]),
  };

  test('a non-English intent routes to its skill', () => {
    const r = structuralRouteMatch('이번 주말 가족 나들이 계획 짜줘 부탁해', index);
    expect(r.matched).toEqual(['family-outing']);
  });

  test('a placeholder trigger no longer collapses onto English intents', () => {
    const r = structuralRouteMatch('fix the typos in this email before I send it', index);
    expect(r.matched).toEqual([]);
  });
});
