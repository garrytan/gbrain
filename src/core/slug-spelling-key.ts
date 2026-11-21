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
 */

const ASCII_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The key as SQL over the `pages.slug` column. The migration and the lookup use this one text, so the planner matches them. */
export const SPELLING_KEY_SQL = `normalize(translate(replace(replace(slug, chr(304), 'i' || chr(775)), chr(8490), 'k'), '${ASCII_UPPER}', '${ASCII_UPPER.toLowerCase()}'), NFC)`;

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

/** The non-ASCII characters whose lowercase is `lower`, built once from the engine's own case mapping. */
function capitalsOf(lower: string): readonly string[] {
  if (!capitalsByLower) {
    capitalsByLower = new Map();
    for (let code = 0x80; code < 0x20000; code++) {
      if (code >= 0xd800 && code < 0xe000) continue;
      const ch = String.fromCodePoint(code);
      const low = ch.toLowerCase();
      if (low === ch || low === ch.toUpperCase()) continue;
      capitalsByLower.set(low, [...(capitalsByLower.get(low) ?? []), ch]);
    }
    // JavaScript lowers a capital sigma to the final form at the end of a word, so no single character maps to it.
    capitalsByLower.set('\u03C2', [...(capitalsByLower.get('\u03C2') ?? []), '\u03A3']);
  }
  return capitalsByLower.get(lower) ?? [];
}

/**
 * The keys of every stored spelling that reads as `normalized` (a slug already lowercased and composed): its own key and
 * the key with each cased non-ASCII letter in any of its capital forms. Null when that is more than
 * `MAX_SPELLING_VARIANTS` spellings, which the caller answers by scanning.
 */
export function spellingKeys(normalized: string): string[] | null {
  const choices = [...normalized].map(ch => ch.codePointAt(0)! < 0x80 ? [ch] : [ch, ...capitalsOf(ch)]);
  let variants = 1;
  for (const options of choices) {
    variants *= options.length;
    if (variants > MAX_SPELLING_VARIANTS) return null;
  }
  let spellings = [''];
  for (const options of choices) spellings = spellings.flatMap(prefix => options.map(option => prefix + option));
  return [...new Set(spellings.map(spellingKey))];
}
