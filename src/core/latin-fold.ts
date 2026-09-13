/**
 * Latin letters whose diacritic is drawn INSIDE the glyph — a stroke, bar, or
 * ligature rather than a floating accent.
 *
 * Unicode assigns these no decomposition mapping, so the usual fold (NFD/NFKD
 * decompose, then strip combining marks U+0300–U+036F) turns "é" into "e" but
 * leaves "đ" exactly as it was. What happens next depends on the grammar
 * downstream, and both outcomes are wrong in the same way:
 *
 *   - a grammar that keeps only `[a-z0-9]` DELETES the letter
 *     ("Đăng Example" → "ang-example");
 *   - a grammar that keeps all letters KEEPS it unfolded
 *     ("Đức Example" → "đuc-example").
 *
 * Neither matches the ASCII form the rest of the pipeline expects, and the
 * mismatch is silent: a slug nothing resolves to, or a basename lookup that
 * misses.
 *
 * Leaf module by design — text primitives only, no engine or graph imports —
 * so every grammar that folds accents can share one table.
 */

/** Keys are lowercase: callers fold after their own lowercasing pass. */
export const NON_DECOMPOSING_LATIN: Readonly<Record<string, string>> = {
  đ: 'd', // U+0111 Vietnamese, Croatian, Sami
  ð: 'd', // U+00F0 Icelandic eth
  ø: 'o', // U+00F8 Danish, Norwegian, Faroese
  ł: 'l', // U+0142 Polish
  ħ: 'h', // U+0127 Maltese
  ŧ: 't', // U+0167 Northern Sami
  ı: 'i', // U+0131 Turkish dotless i
  ß: 'ss', // U+00DF German sharp s
  æ: 'ae', // U+00E6 Danish, Norwegian, Icelandic
  œ: 'oe', // U+0153 French
  þ: 'th', // U+00FE Icelandic thorn
};

const NON_DECOMPOSING_RE = new RegExp(`[${Object.keys(NON_DECOMPOSING_LATIN).join('')}]`, 'g');

/**
 * Fold stroke/bar/ligature letters to their base ASCII letters.
 *
 * Call AFTER lowercasing (the table is lowercase-keyed) and AFTER the
 * combining-mark strip, so composed forms reduce in a single pass:
 * "ǿ" → NFD → "ø" + U+0301 → mark stripped → "ø" → "o".
 */
export function foldNonDecomposingLatin(s: string): string {
  return s.replace(NON_DECOMPOSING_RE, ch => NON_DECOMPOSING_LATIN[ch]);
}
