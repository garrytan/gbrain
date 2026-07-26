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
 *   - strip leading/trailing whitespace
 *   - collapse internal whitespace runs to a single space
 *   - drop surrounding quotes/brackets the YAML parser may leave
 *
 * Returns '' for input that normalizes to empty — callers MUST skip empty
 * aliases (an empty alias would match empty/whitespace queries).
 */

export function normalizeAlias(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .toLowerCase()
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
  const push = (v: unknown) => {
    if (typeof v !== 'string') return;
    const n = normalizeAlias(v);
    if (n.length > 0) out.add(n);
  };
  if (Array.isArray(value)) {
    for (const v of value) push(v);
  } else if (typeof value === 'string') {
    // A scalar `aliases: Hall of Light` OR a comma-list `aliases: a, b`.
    if (value.includes(',')) value.split(',').forEach(push);
    else push(value);
  }
  return Array.from(out);
}
