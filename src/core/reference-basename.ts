import { foldNonDecomposingLatin } from './latin-fold.ts';
const SLUG_WORD_CHARS = '\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}\\p{N}';
const SLUG_VARIATION_SELECTORS_RE = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
const BASENAME_KEEP_RE = new RegExp(`[^${SLUG_WORD_CHARS}\\s\\-]`, 'gu');
export function normalizeBasename(s: string): string {
  // The accent strip cannot fold stroke letters \u2014 Unicode gives them no
  // decomposition \u2014 so the shared table runs after it, on both the index and
  // the query side. Without it a display name keeps the unfolded letter while
  // the ASCII page slug does not, and the lookup misses in silence:
  // `[[\u0110\u1ee9c Example]]` keyed `\u0111uc-example` and never found `people/duc-example`.
  const folded = foldNonDecomposingLatin(
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
      .replace(SLUG_VARIATION_SELECTORS_RE, '').toLowerCase(), // twin of slugifySegment's strip (#4985)
  );
  return folded.replace(BASENAME_KEEP_RE, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Stable order: shorter slug first (likely closer to brain root), then lexical. */
function basenameSort(a: string, b: string): number {
  return (a.length - b.length) || a.localeCompare(b);
}

/** Build a `key → slug[]` index over a slug collection. Keys: raw/lower/slugified tail. */
export function buildBasenameIndex(slugs: Iterable<string>): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  const addKey = (key: string, slug: string) => {
    const existing = idx.get(key);
    if (existing) { if (!existing.includes(slug)) existing.push(slug); }
    else idx.set(key, [slug]);
  };
  for (const slug of slugs) {
    const tail = slug.includes('/') ? slug.slice(slug.lastIndexOf('/') + 1) : slug;
    addKey(tail, slug);
    const lower = tail.toLowerCase();
    if (lower !== tail) addKey(lower, slug);
    const slugified = normalizeBasename(tail);
    if (slugified && slugified !== tail && slugified !== lower) addKey(slugified, slug);
  }
  return idx;
}

/** Look a name up in a basename index (raw → lower → slugified), stable-sorted. */
export function queryBasenameIndex(idx: Map<string, string[]>, name: string): string[] {
  if (!name || typeof name !== 'string') return [];
  const trimmed = name.trim();
  if (!trimmed) return [];
  const hit = idx.get(trimmed) ?? idx.get(trimmed.toLowerCase()) ?? idx.get(normalizeBasename(trimmed));
  return hit ? [...hit].sort(basenameSort) : [];
}

