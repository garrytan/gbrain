/**
 * The key `idx_pages_spelling_key` holds for each page, and the keys a lookup probes it with.
 *
 * Slugs are stored lowercase and in composed Unicode (NFC), but a page written before that rule keeps the spelling it was
 * saved under (capitals, or decomposed accents). Finding every stored spelling that reads as one slug needs a key that
 * every such spelling shares, built where Postgres can index it. Postgres cannot lowercase non-ASCII letters the way
 * JavaScript does (that depends on the database's locale), so the key lowers only what is certain: the ASCII capitals,
 * and the two capitals whose lowercase holds ASCII (U+0130 lowers to `i` and a combining dot, U+212A to `k`); then it
 * composes the text. Every other letter keeps its case. A slug's other spellings are therefore found by the key of the
 * slug itself plus the keys of its capital forms (`spellingKeys`), and the caller still compares with `normalizeSlug`.
 *
 * Lowercasing and composing do not commute character by character (a stored capital iota with diaeresis, U+03AA, followed
 * by a combining acute lowercases and composes to U+0390, for which no single capital exists), so the capital forms are
 * enumerated over the slug's decomposed text (NFD), where each letter and each mark stands alone, and every candidate is
 * composed by the same key function. That is complete because the stored spelling's NFD keeps each letter's mark
 * sequence and differs from the slug's only by the case of its letters; the table build below checks that for every
 * character, and a letter of a character that fails it makes `spellingKeys` answer null (the caller scans instead).
 */

import type { BrainEngine } from './engine.ts';

const ASCII_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The key as SQL over the `pages.slug` column. The migration and the lookup use this one text, so the planner matches them. */
export const SPELLING_KEY_SQL = `normalize(translate(replace(replace(slug, chr(304), 'i' || chr(775)), chr(8490), 'k'), '${ASCII_UPPER}', '${ASCII_UPPER.toLowerCase()}'), NFC)`;

/**
 * The SQL side of `normalizeSlug` as an ASCII-only key, the scan a lookup falls back to for a slug with too many capital
 * variants for the index (`spellingKeys`): every row that normalizes to a slug shares this key with it. The capitals are
 * lowered by hand, never by the engine's locale, then the text is composed and cut down to ASCII letters and digits. Unindexed.
 */
export const SCAN_KEY_SQL = `regexp_replace(${SPELLING_KEY_SQL}, '[^a-z0-9]', '', 'g')`;

/** The database's server encoding. `SPELLING_KEY_SQL` can be evaluated only when it is UTF8 (PGLite always is). */
export async function serverEncoding(db: Pick<BrainEngine, 'executeRaw'>): Promise<string> {
  const [row] = await db.executeRaw<{ server_encoding: string }>('SHOW server_encoding');
  return row?.server_encoding ?? 'unknown';
}

/** The index the lookup probes: the key, then the source, so a lookup in one source never reads another's rows. */
export const SPELLING_KEY_INDEX = 'idx_pages_spelling_key';
export const SPELLING_KEY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${SPELLING_KEY_INDEX} ON pages ((${SPELLING_KEY_SQL}), source_id)`;

/**
 * The most capital spellings of one slug the lookup probes by index. A slug with more (it has many cased letters outside
 * ASCII, each of which may be stored in either case) is answered by the scan instead.
 */
export const MAX_SPELLING_VARIANTS = 256;

/** The key of one stored spelling: what `SPELLING_KEY_SQL` computes, in JavaScript. */
export function spellingKey(slug: string): string {
  return slug.replace(/\u0130/g, 'i\u0307').replace(/\u212A/g, 'k').replace(/[A-Z]/g, c => c.toLowerCase()).normalize('NFC');
}

let capitalsByLower: Map<string, string[]> | undefined;
/** Letters of characters whose decomposed capital form is not the decomposed lowercase form with each letter in its own case; none today. */
let irregular: Set<string> | undefined;

/** The non-ASCII characters whose lowercase is `lower`, built once from the engine's own case mapping. */
function capitalsOf(lower: string): readonly string[] {
  ensureTables();
  return capitalsByLower!.get(lower) ?? [];
}

function ensureTables(): void {
  if (!capitalsByLower) {
    capitalsByLower = new Map();
    for (let code = 0x80; code < 0x20000; code++) {
      if (code >= 0xd800 && code < 0xe000) continue;
      const ch = String.fromCodePoint(code);
      const low = ch.toLowerCase();
      if (low === ch || low === ch.toUpperCase()) continue;
      capitalsByLower.set(low, [...(capitalsByLower.get(low) ?? []), ch]);
      // The decomposed capital and the decomposed lowercase must line up letter for letter, each capital letter lowering to its partner.
      const capital = [...ch.normalize('NFD')], lower = [...low.normalize('NFD')];
      if (capital.length !== lower.length || capital.some((c, i) => c !== lower[i] && c.toLowerCase() !== lower[i])) for (const c of lower) (irregular ??= new Set()).add(c);
    }
    // JavaScript lowers a capital sigma to the final form at the end of a word, so no single character maps to it.
    capitalsByLower.set('\u03C2', [...(capitalsByLower.get('\u03C2') ?? []), '\u03A3']);
    irregular ??= new Set();
  }
}

/**
 * The keys of every stored spelling that reads as `normalized` (a slug already lowercased and composed): its own key and
 * the key with each cased non-ASCII letter of its decomposed text in any of its capital forms. Null when that is more
 * than `MAX_SPELLING_VARIANTS` spellings, or the text holds a letter whose capital forms do not line up with its own
 * (none today), which the caller answers by scanning.
 */
export function spellingKeys(normalized: string): string[] | null {
  const letters = [...normalized.normalize('NFD')];
  ensureTables();
  if (letters.some(ch => irregular!.has(ch))) return null;
  // An ASCII letter followed by a non-ASCII mark may be stored as part of a composed capital (`É` is `E` and an acute), which the key does not lower.
  const choices = letters.map((ch, i) => ch.codePointAt(0)! >= 0x80 ? [ch, ...capitalsOf(ch)]
    : ch !== ch.toUpperCase() && (letters[i + 1]?.codePointAt(0) ?? 0) >= 0x80 ? [ch, ch.toUpperCase()] : [ch]);
  let variants = 1;
  for (const options of choices) {
    variants *= options.length;
    if (variants > MAX_SPELLING_VARIANTS) return null;
  }
  let spellings = [''];
  for (const options of choices) spellings = spellings.flatMap(prefix => options.map(option => prefix + option));
  // The key never holds an ASCII capital (it lowers those before composing), so a candidate that still has one stands for no stored spelling.
  return [...new Set(spellings.map(spelling => spelling.normalize('NFC')).filter(key => !/[A-Z]/.test(key)))];
}
