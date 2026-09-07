/**
 * latin-fold — the shared table of Latin letters whose diacritic is drawn
 * INSIDE the glyph (stroke, bar, ligature). Unicode gives them no
 * decomposition, so the usual NFD + strip-combining-marks fold leaves them
 * untouched and every downstream grammar either deletes or keeps the letter
 * unfolded ("Đức Example" → "uc-example" / "đuc-example"). Both consumers —
 * `slugify` (entity resolution) and `normalizeBasename` (the FS link
 * resolver's basename index) — must run the table AFTER their mark strip.
 */
import { describe, expect, test } from 'bun:test';
import { NON_DECOMPOSING_LATIN, foldNonDecomposingLatin } from '../src/core/latin-fold.ts';
import { slugify } from '../src/core/entities/resolve.ts';
import { normalizeBasename } from '../src/core/link-extraction.ts';

const stripMarks = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

describe('foldNonDecomposingLatin', () => {
  for (const [letter, ascii] of Object.entries(NON_DECOMPOSING_LATIN)) {
    const cp = letter.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
    test(`${letter} (U+${cp}) → ${ascii}`, () => {
      // The reason the row exists: the mark strip alone cannot fold it.
      expect(stripMarks(letter)).toBe(letter);
      expect(foldNonDecomposingLatin(letter)).toBe(ascii);
    });
  }

  test('folds every occurrence and leaves other letters alone', () => {
    expect(foldNonDecomposingLatin('løøp straße')).toBe('loop strasse');
  });

  test('a composed form reduces in one pass after the mark strip (ǿ → ø → o)', () => {
    expect(foldNonDecomposingLatin(stripMarks('ǿ'))).toBe('o');
  });
});

describe('consumers fold the ligature and eth letters', () => {
  const cases: Array<[string, string]> = [
    ['Æsir Example', 'aesir-example'],
    ['Œuvre', 'oeuvre'],
    ['Ðorðe Example', 'dorde-example'],
  ];
  for (const [input, expected] of cases) {
    test(`slugify(${JSON.stringify(input)}) → ${expected}`, () => {
      expect(slugify(input)).toBe(expected);
    });
    test(`normalizeBasename(${JSON.stringify(input)}) → ${expected}`, () => {
      expect(normalizeBasename(input)).toBe(expected);
    });
  }
});
