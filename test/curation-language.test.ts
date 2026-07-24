/**
 * Tests for src/core/ai/curation-language.ts (#3357 configurable curation
 * output-language policy).
 */
import { describe, test, expect } from 'bun:test';
import { detectDominantLanguage, curationLanguageDirective } from '../src/core/ai/curation-language.ts';

describe('detectDominantLanguage', () => {
  test('Hangul-dominant text → ko', () => {
    expect(detectDominantLanguage('디사일로 시리즈B 라운드에서 부분 엑싯 목표')).toBe('ko');
  });
  test('Latin-dominant text → en', () => {
    expect(detectDominantLanguage('targeting a partial exit in the Series B round')).toBe('en');
  });
  test('mostly-Latin with a stray Hangul char → en (ratio guard)', () => {
    expect(detectDominantLanguage('mostly english text with one 디 char here and there')).toBe('en');
  });
  test('empty string → en', () => {
    expect(detectDominantLanguage('')).toBe('en');
  });
});

describe('curationLanguageDirective', () => {
  const cfg = (v: string | null) => ({ getConfig: async () => v });

  test('default "source" (unset config) matches the input language', async () => {
    const ko = await curationLanguageDirective(cfg(null), '디사일로 이승명 세후 30억 부분 엑싯');
    expect(ko).toContain('in Korean');
    const en = await curationLanguageDirective(cfg(null), 'plain english only text here');
    expect(en).toContain('in English');
  });

  test('null engine falls open to "source"', async () => {
    expect(await curationLanguageDirective(null, '디사일로 시리즈B 라운드')).toContain('in Korean');
  });

  test('"off" / "none" → empty (prior native behavior)', async () => {
    expect(await curationLanguageDirective(cfg('off'), '디사일로')).toBe('');
    expect(await curationLanguageDirective(cfg('none'), '디사일로')).toBe('');
  });

  test('explicit language code forces that language regardless of input', async () => {
    expect(await curationLanguageDirective(cfg('ja'), 'anything at all')).toContain('in Japanese');
    expect(await curationLanguageDirective(cfg('ko'), 'plain english input')).toContain('in Korean');
  });

  test('a getConfig that throws falls open to "source" (never breaks a phase)', async () => {
    const throwing = { getConfig: async () => { throw new Error('db down'); } };
    expect(await curationLanguageDirective(throwing, '디사일로 라운드 엑싯')).toContain('in Korean');
  });
});
