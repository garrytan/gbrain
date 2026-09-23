/**
 * T3 — alias normalization (retrieval-maxpool incident, alias layer).
 *
 * ONE normalizer shared by the WRITE path (ingest projects frontmatter
 * `aliases:` into page_aliases) and the READ path (search matches the query
 * against page_aliases). If the two sides normalized differently — one
 * lowercases, the other also collapses whitespace — stored aliases would
 * silently never match queries, and there'd be no error to notice. Same
 * single-source-of-truth posture as cjk.ts / escapeLikePattern.
 *
 * Normalization (deliberately aggressive + deterministic):
 *   - Unicode NFKC (so 明堂 and full/half-width variants converge)
 *   - lowercase
 *   - Cyrillic: ё → е, stress mark (U+0301) dropped (ADR-0001)
 *   - strip leading/trailing whitespace
 *   - collapse internal whitespace runs to a single space
 *   - drop surrounding quotes/brackets the YAML parser may leave
 *
 * Returns '' for input that normalizes to empty — callers MUST skip empty
 * aliases (an empty alias would match empty/whitespace queries).
 */

const CYRILLIC_YO_RE = /ё/g;
const CYRILLIC_STRESS_RE = /([\u0400-\u04FF])\u0301+/g;

export function normalizeAlias(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .toLowerCase()
    // ADR-0001: slugs keep ё; aliases merge ё with е, and drop a Cyrillic
    // stress mark (U+0301 left combining after NFKC), so spelling variants of
    // one Russian name share a key. й is NOT folded. Migration v164 applies
    // the same two folds to stored rows; test/cyrillic-slug-grammar.test.ts
    // pins the SQL and this function to the same keys.
    .replace(CYRILLIC_YO_RE, 'е')
    .replace(CYRILLIC_STRESS_RE, '$1')
    .replace(/[\s ]+/g, ' ')
    .trim()
    // strip a single layer of wrapping quotes/brackets left by loose YAML
    .replace(/^["'`\[(]+/, '')
    .replace(/["'`\])]+$/, '')
    .trim();
}

/**
 * Coerce a frontmatter `aliases:` value (which may be a scalar string, an
 * array, or absent/garbage) into a deduped list of normalized, non-empty
 * aliases. Used by the ingest projection AND the backfill walker so both
 * derive the same alias set from the same JSONB.
 */
export function normalizeAliasList(value: unknown): string[] {
  const out = new Set<string>();
  for (const v of aliasListValues(value)) {
    const n = normalizeAlias(v);
    if (n.length > 0) out.add(n);
  }
  return Array.from(out);
}

/**
 * The raw (display-form) aliases in a frontmatter `aliases:` value: an array's
 * strings, or a scalar split on commas (`aliases: a, b`). Garbage → [].
 */
export function aliasListValues(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}
