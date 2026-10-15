/**
 * `slug.transliterate`: opt-in transliteration of non-Latin letters before
 * gbrain normalizes text into a NEW slug or entity key.
 *
 *   off       (default) upstream behaviour, nothing is transliterated.
 *   cyrillic  Cyrillic letters are spelled in Latin first
 *             ("абв" → "abv", "щж" → "shchzh", "юя" → "yuya").
 *
 * Without it the two slug grammars treat Cyrillic differently, and both lose:
 * the ASCII `slugify` (entity resolution, fact entity keys) drops every
 * Cyrillic letter, so "абв" resolves to '' and "people/абв" to "people";
 * the Unicode `slugifySegment` (atom, concept and transcript slugs) keeps
 * Cyrillic but strips combining marks, so "й" becomes "и" and "ё" becomes "е".
 *
 * Applied only where a slug is minted from free text (names, titles, concept
 * labels) and in the ASCII `slugify`, which already erased Cyrillic, so
 * enabling it cannot change how an existing Latin slug resolves. File-path
 * sync and wikilink resolution keep their native-script grammar: re-slugging
 * a synced file or link target would orphan the existing page.
 *
 * The mode is process-wide and read once per process at engine startup
 * (core/engine-connect.ts, behind every CLI command and `serve`): the slug
 * helpers are synchronous and deep in pure code, so it is not threaded through
 * every call. Restart long-running processes (serve, workers) after changing it.
 */
import type { BrainEngine } from './engine.ts';

export type SlugTransliterateMode = 'off' | 'cyrillic';

export const SLUG_TRANSLITERATE_CONFIG_KEY = 'slug.transliterate';

let mode: SlugTransliterateMode = 'off';

/**
 * One deterministic table, BGN/PCGN-like and simplified for slugs: no
 * diacritics, no positional rules, hard and soft signs dropped. A letter
 * that reads differently across alphabets keeps one value (г → g, и → i).
 */
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // beyond the base table
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

/** Spell Cyrillic letters in lowercase Latin; everything else passes through. */
export function transliterateCyrillic(text: string): string {
  // NFC first: a decomposed "й" (и + U+0306) must map as "y", not as "i" plus a stray mark.
  return text.normalize('NFC').replace(/[Ѐ-ӿ]/g, (ch) => CYRILLIC_TO_LATIN[ch.toLowerCase()] ?? ch);
}

/** Text as the slug minters should see it under the current mode. */
export function transliterateForSlug(text: string): string {
  return mode === 'cyrillic' ? transliterateCyrillic(text) : text;
}

export function getSlugTransliterate(): SlugTransliterateMode {
  return mode;
}

/** Set the process-wide mode. Anything but `cyrillic` (case-insensitive) is `off`. */
export function setSlugTransliterate(value: unknown): SlugTransliterateMode {
  mode = typeof value === 'string' && value.trim().toLowerCase() === 'cyrillic' ? 'cyrillic' : 'off';
  return mode;
}

/** Read `slug.transliterate` from the DB plane; an unknown value warns and stays `off`. */
export async function loadSlugTransliterate(engine: Pick<BrainEngine, 'getConfig'>): Promise<SlugTransliterateMode> {
  const raw = (await engine.getConfig(SLUG_TRANSLITERATE_CONFIG_KEY))?.trim() ?? '';
  const next = setSlugTransliterate(raw);
  if (raw !== '' && next === 'off' && raw.toLowerCase() !== 'off') {
    console.error(`[gbrain] ${SLUG_TRANSLITERATE_CONFIG_KEY}="${raw.slice(0, 40)}" is not off|cyrillic; using off.`);
  }
  return next;
}
