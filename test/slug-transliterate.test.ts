import { describe, test, expect, afterEach } from 'bun:test';
import {
  transliterateCyrillic,
  transliterateForSlug,
  setSlugTransliterate,
  getSlugTransliterate,
  loadSlugTransliterate,
} from '../src/core/slug-transliterate.ts';
import { slugify } from '../src/core/entities/resolve.ts';
import { slugifySegment, slugifyMintedSegment } from '../src/core/sync.ts';
import { slugifyEntity } from '../src/core/enrichment-service.ts';
import { buildTranscriptSlug } from '../src/core/transcripts/types.ts';

afterEach(() => { setSlugTransliterate('off'); });

describe('transliterateCyrillic', () => {
  test('single- and multi-letter mappings', () => {
    expect(transliterateCyrillic('абв')).toBe('abv');
    expect(transliterateCyrillic('АБВ')).toBe('abv');
    expect(transliterateCyrillic('щжх')).toBe('shchzhkh');
    expect(transliterateCyrillic('юя')).toBe('yuya');
    expect(transliterateCyrillic('ёъь')).toBe('yo');
  });

  test('letters beyond the base table', () => {
    expect(transliterateCyrillic('ґїєі')).toBe('gyiyei');
  });

  test('decomposed (NFD) й maps like the composed letter', () => {
    expect(transliterateCyrillic('ай'.normalize('NFD'))).toBe('ay');
  });

  test('Latin, digits and other scripts pass through', () => {
    expect(transliterateCyrillic('abc 42')).toBe('abc 42');
    expect(transliterateCyrillic('一二三')).toBe('一二三');
  });
});

describe('slug.transliterate mode', () => {
  test('defaults to off and leaves text untouched', () => {
    expect(getSlugTransliterate()).toBe('off');
    expect(transliterateForSlug('абв')).toBe('абв');
  });

  test('only "cyrillic" (any case) turns it on', () => {
    expect(setSlugTransliterate('Cyrillic')).toBe('cyrillic');
    expect(setSlugTransliterate('latin')).toBe('off');
    expect(setSlugTransliterate(undefined)).toBe('off');
  });

  test('loadSlugTransliterate reads the config key', async () => {
    const engine = (value: string | null) => ({ getConfig: async () => value });
    expect(await loadSlugTransliterate(engine('cyrillic'))).toBe('cyrillic');
    expect(await loadSlugTransliterate(engine(null))).toBe('off');
    expect(await loadSlugTransliterate(engine('bogus'))).toBe('off');
  });
});

describe('off is upstream behaviour', () => {
  test('slug helpers are unchanged', () => {
    expect(slugify('абв')).toBe('');
    expect(slugifySegment('абй вгё')).toBe('аби-вге');
    expect(slugifyMintedSegment('абй вгё')).toBe(slugifySegment('абй вгё'));
    expect(slugifyEntity('абй', 'company')).toBe('companies/аби');
    expect(slugify('abc def')).toBe('abc-def');
  });
});

describe('cyrillic mints Latin slugs', () => {
  test('entity keys, minted segments, entity pages, transcript titles', () => {
    setSlugTransliterate('cyrillic');
    expect(slugify('абв')).toBe('abv');
    expect(slugifyMintedSegment('абй вгё')).toBe('aby-vgyo');
    expect(slugifyEntity('абй', 'company')).toBe('companies/aby');
    expect(buildTranscriptSlug('chatgpt', '2026-01-15T10:00:00Z', { sessionId: 'abc123', title: 'абв гдж' }))
      .toMatch(/\/2026-01-15-abv-gdzh-/);
  });

  test('Latin input is unchanged', () => {
    setSlugTransliterate('cyrillic');
    expect(slugify('abc def')).toBe('abc-def');
    expect(slugifyEntity('abc def', 'company')).toBe('companies/abc-def');
  });

  test('file-path slugs keep their native script', () => {
    setSlugTransliterate('cyrillic');
    expect(slugifySegment('абв')).toBe('абв');
  });
});
