// v0.42 (T20, plan D14) — type filter back-compat helper.
//
// Problem: after unify-types runs, pages with type='article' become
// type='media' with frontmatter.subtype='article'. Existing scripts that
// run `gbrain extract --type article` would return zero pages.
//
// Fix: expand the user-supplied type at query construction time. If the
// type is declared as an ALIAS of a canonical type (per the active
// pack's page_types[].aliases), AND the canonical type declares a
// matching subtype rule, expand to match BOTH:
//   - residual pre-unify pages: type = 'article'
//   - post-unify pages: type = 'media' AND frontmatter->>'subtype' = 'article'
//
// Single source of truth — both extract CLI + future operations.ts
// list_pages adopt this helper to avoid drift.
//
// D4 EMPTY FILTER contract: pack-load failure → degrades to exact-match
// behavior (the helper returns { canonical: type, isAliasExpansion: false }).
// Existing tests pass unchanged on pack-less brains.

import type { SchemaPackManifest } from './manifest-v1.ts';

export interface ExpandedTypeFilter {
  /** The canonical type to match (always present). */
  canonical: string;
  /**
   * If non-null: also match (type = canonical AND frontmatter[field] = value).
   * Use the SQL OR semantics:
   *   (type = $1 OR (type = $2 AND frontmatter->>$3 = $4))
   *
   * When null: simple `type = $canonical` lookup.
   */
  subtypeFilter: { canonical: string; subtypeField: string; subtypeValue: string } | null;
  /** True when the input was an alias that mapped to a canonical type. */
  isAliasExpansion: boolean;
  /** The original input type (preserved for residual-match SQL). */
  originalInput: string;
}

/**
 * Expand a user-supplied --type value against the active pack. When the
 * input is an alias declared on a canonical type, and that canonical
 * declares a matching subtype rule, expand to the canonical+subtype
 * tuple. Otherwise, return the input unchanged (exact-match semantics).
 *
 * Examples (against gbrain-base-v2):
 *   expandTypeFilter('article', pack)
 *     → { canonical: 'media', subtypeFilter: { canonical: 'media',
 *         subtypeField: 'subtype', subtypeValue: 'article' },
 *         isAliasExpansion: true, originalInput: 'article' }
 *   expandTypeFilter('media', pack)
 *     → { canonical: 'media', subtypeFilter: null,
 *         isAliasExpansion: false, originalInput: 'media' }
 *   expandTypeFilter('unknown-type', pack)
 *     → { canonical: 'unknown-type', subtypeFilter: null,
 *         isAliasExpansion: false, originalInput: 'unknown-type' }
 *
 * Subtype-rule matching: prefers frontmatter-keyed rules; falls back to
 * path-pattern rules (matched against the alias's expected canonical
 * subtype name). For now, only frontmatter-based subtypes drive query
 * expansion — path-pattern subtypes (like `media:video` from `^videos/`)
 * are handled by the legacy `type = 'video'` literal during the
 * pre-unify residual phase.
 */
export function expandTypeFilter(
  type: string,
  pack: Pick<SchemaPackManifest, 'page_types'> | null | undefined,
): ExpandedTypeFilter {
  if (!pack) {
    return {
      canonical: type,
      subtypeFilter: null,
      isAliasExpansion: false,
      originalInput: type,
    };
  }
  // 1. If `type` is itself a canonical (declared in page_types), pass through.
  if (pack.page_types.some((pt) => pt.name === type)) {
    return {
      canonical: type,
      subtypeFilter: null,
      isAliasExpansion: false,
      originalInput: type,
    };
  }
  // 2. Search for `type` as an alias of any canonical.
  for (const pt of pack.page_types) {
    if (!pt.aliases?.includes(type)) continue;
    // 2a. CANONICAL ANSWER — consult mapping_rules. The retype rule for
    // `from_type: type` is the source of truth for what subtype value
    // the unify pass stamped on the page's frontmatter. Use that
    // rule's subtype + subtype_field for the query expansion.
    const mappingRules = (pack as { mapping_rules?: unknown[] }).mapping_rules;
    if (Array.isArray(mappingRules)) {
      for (const rule of mappingRules) {
        if (typeof rule !== 'object' || rule === null) continue;
        const r = rule as { kind?: unknown; from_type?: unknown; subtype?: unknown; subtype_field?: unknown };
        if (r.kind !== 'retype') continue;
        if (r.from_type !== type) continue;
        if (typeof r.subtype !== 'string') continue;
        return {
          canonical: pt.name,
          subtypeFilter: {
            canonical: pt.name,
            subtypeField: typeof r.subtype_field === 'string' ? r.subtype_field : 'subtype',
            subtypeValue: r.subtype,
          },
          isAliasExpansion: true,
          originalInput: type,
        };
      }
    }
    // 2b. FALLBACK 1: subtype rule on the page_type whose `name === type`.
    // Common case for hand-written packs that declare subtypes but don't
    // wire mapping_rules.
    const subtypeRule = pt.subtypes?.find((s) => s.name === type);
    if (subtypeRule?.when.frontmatter_field !== undefined
        && subtypeRule.when.frontmatter_value !== undefined) {
      const v = subtypeRule.when.frontmatter_value;
      const subtypeValue = typeof v === 'boolean' ? String(v)
        : typeof v === 'number' ? String(v)
        : String(v);
      return {
        canonical: pt.name,
        subtypeFilter: {
          canonical: pt.name,
          subtypeField: subtypeRule.when.frontmatter_field,
          subtypeValue,
        },
        isAliasExpansion: true,
        originalInput: type,
      };
    }
    // 2c. FALLBACK 2: no mapping_rule + no matching subtype rule. Use
    // subtype=alias-name (assumes the unify pass stamped subtype as the
    // alias name itself, which is the catch-all behavior).
    return {
      canonical: pt.name,
      subtypeFilter: {
        canonical: pt.name,
        subtypeField: 'subtype',
        subtypeValue: type,
      },
      isAliasExpansion: true,
      originalInput: type,
    };
  }
  // 4. Not in page_types AND not in any aliases list. Pass through unchanged
  // (legacy/unknown type — let the SQL match-or-not naturally).
  return {
    canonical: type,
    subtypeFilter: null,
    isAliasExpansion: false,
    originalInput: type,
  };
}

/**
 * Build the SQL WHERE fragment for an expanded type filter. Returns the
 * fragment with `$1`-style placeholders + the params array (in order).
 *
 * Callers must offset the placeholder indices via their own param counter
 * — this helper assumes the WHERE is being built from scratch (starts at $1).
 * Use `renumberPlaceholders` if composing with other clauses.
 */
export function buildTypeFilterSql(
  expanded: ExpandedTypeFilter,
  startParamIndex: number = 1,
): { sql: string; params: string[] } {
  if (!expanded.isAliasExpansion || !expanded.subtypeFilter) {
    return {
      sql: `type = $${startParamIndex}`,
      params: [expanded.originalInput],
    };
  }
  const i = startParamIndex;
  return {
    sql: `(type = $${i} OR (type = $${i + 1} AND frontmatter ->> $${i + 2} = $${i + 3}))`,
    params: [
      expanded.originalInput,
      expanded.subtypeFilter.canonical,
      expanded.subtypeFilter.subtypeField,
      expanded.subtypeFilter.subtypeValue,
    ],
  };
}
