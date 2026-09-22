// v0.38 T7b: pack-aware link verb inference.
//
// The pre-v0.38 `inferLinkType` (in src/core/link-extraction.ts) uses
// rich production regexes (FOUNDED_RE / INVESTED_RE / ADVISES_RE /
// WORKS_AT_RE / PARTNER_ROLE_RE / ADVISOR_ROLE_RE / EMPLOYEE_ROLE_RE)
// that are highly tuned against real brain content. Reproducing these
// in gbrain-base.yaml literally would require multi-line YAML escape
// jujitsu and lose the in-source comments documenting WHY each pattern
// is shaped the way it is.
//
// Pragmatic split: gbrain-base.yaml carries verb NAMES + simplified
// SKETCH regexes (sufficient for documentation + community-pack
// authors who want to copy the pattern); the production regexes stay
// where they are in link-extraction.ts. `inferLinkTypeFromPack`
// CONSULTS pack-declared verbs IN ADDITION TO the in-code matchers —
// it does not REPLACE them. User packs ADD verbs (e.g.
// `weakens`, `supports`, `replicates`) by declaring
// `link_types[].inference.regex` in their manifest; those run under
// the v0.38 ReDoS guard.
//
// Resolution order (matches legacy inferLinkType where applicable):
//   1. Page-type-bound verbs from pack (e.g. meeting → attended,
//      image → image_of). Declared via `inference.page_type` on the
//      pack link_type entry.
//   2. Pack-declared regex matchers (in declaration order from the
//      manifest; first match wins). Runs under PageRegexBudget for
//      ReDoS protection.
//   3. Fall-through to the caller's legacy `inferLinkType` for
//      gbrain-base's production-quality matching of founded /
//      invested_in / advises / works_at + page-role priors.
//
// Callers that want pack-aware behavior wrap their inference call:
//   const packVerb = inferLinkTypeFromPack(pack, pageType, context, budget);
//   if (packVerb) return packVerb;
//   return inferLinkType(pageType, context, globalContext, targetSlug);
//
// Pack-driven verbs WIN over legacy inference because users opt into
// them deliberately; legacy fall-through covers the gbrain-base
// universe.

import type { SchemaPackManifest } from './manifest-v1.ts';
import { PageRegexBudget, runRegexBounded, runRegexBoundedAll } from './redos-guard.ts';

/**
 * Try to resolve a link verb from the active pack's declared
 * link_types. Returns the verb name on a match, or null if no
 * pack-declared rule fired (caller should fall through to the
 * legacy inferLinkType for built-in matchers).
 *
 * Pack-declared verbs MAY be the same name as a built-in (e.g. a
 * user pack declares its own `founded` regex tuned for their
 * domain). When the pack regex matches, the pack wins — that's the
 * point of letting users override.
 */
export function inferLinkTypeFromPack(
  pack: Pick<SchemaPackManifest, 'link_types'>,
  pageType: string,
  context: string,
  budget?: PageRegexBudget,
): string | null {
  // Pass 1: page-type-bound verbs (e.g. meeting → attended). These
  // are deterministic; no regex needed.
  for (const lt of pack.link_types) {
    if (lt.inference?.page_type && lt.inference.page_type === pageType) {
      return lt.name;
    }
  }
  // Pass 2: regex matchers under the ReDoS guard.
  // Caller passes a PageRegexBudget instance so cumulative regex
  // time on this page stays capped at LINK_EXTRACTION_TOTAL_BUDGET_MS.
  for (const lt of pack.link_types) {
    const pattern = lt.inference?.regex;
    if (!pattern) continue;
    if (budget) {
      const match = budget.runBounded(lt.name, pattern, context);
      if (match === undefined) {
        // Budget exhausted — caller's surrounding logic falls through
        // to mentions per design.
        return null;
      }
      if (match !== null) return lt.name;
    } else {
      // No budget provided (test contexts) — still route through the bounded
      // executor so the v0.41.37.0 #1569 input-length cap + vm timeout apply.
      // Previously this ran `new RegExp(pattern).test(context)` UNBOUNDED, the
      // one ReDoS hole with no timeout. runRegexBounded throws on
      // timeout/oversize/malformed → skip and continue (degrade to mentions).
      try {
        if (runRegexBounded(pattern, context) !== null) return lt.name;
      } catch {
        // Timed out, oversize input, or malformed pattern — skip and continue.
        // Pack validation + the star-height lint rule surface bad patterns.
      }
    }
  }
  return null;
}

/**
 * Frontmatter-field → link-verb resolution from a pack manifest.
 * Mirrors the legacy `FRONTMATTER_LINK_MAP` table; pack-aware variant
 * walks `pack.frontmatter_links[]` instead of the hardcoded array.
 *
 * Returns the link-type name for the matching (page_type, field)
 * combination, or null if no rule fires. Order: pack manifest order
 * (first match wins).
 */
export function frontmatterLinkTypeFromPack(
  pack: Pick<SchemaPackManifest, 'frontmatter_links'>,
  pageType: string | undefined,
  fieldName: string,
): string | null {
  for (const fl of pack.frontmatter_links) {
    if (fl.page_type !== undefined && fl.page_type !== pageType) continue;
    if (fl.fields.includes(fieldName)) return fl.link_type;
  }
  return null;
}

/**
 * One resolved edge produced by a pack-declared `identifier_links[]` rule.
 * `index`/`matchText` let the caller (link-extraction.ts) build the same
 * excerpt-context window every other candidate gets.
 */
export interface IdentifierLinkMatch {
  targetSlug: string;
  linkType: string;
  matchText: string;
  index: number;
  ruleName: string;
}

export interface IdentifierLinkResolution {
  candidates: IdentifierLinkMatch[];
  /**
   * Count of matches whose resolved target template ended in `*` and
   * matched MORE THAN ONE live slug — skipped rather than guessed. Exposed
   * so tests (and, eventually, an extract-summary counter) can observe the
   * gap instead of it silently vanishing, same spirit as extract.ts's
   * `skippedMissingTarget`.
   */
  ambiguousCount: number;
}

/**
 * Resolve every pack-declared `identifier_links[]` rule against a page
 * body, producing graph-edge candidates for bare-identifier citations
 * (DECISION-073, ADR-0047, SPA-2442) that the markdown/wikilink/bare-slug
 * passes in link-extraction.ts never catch — those all require slug-shaped
 * text, and by-mention.ts's gazetteer only knows person/company/
 * organization/entity titles.
 *
 * Requires `liveSlugs` — the caller's live slug set — to turn a matched
 * identifier into a real page reference; a pack with rules but no
 * `liveSlugs` supplied (put_page's single-page write, the recency sweep —
 * neither has a full live-slug picture available cheaply) is a no-op,
 * mirroring how those same callers already skip the DB-path ancestor-walk
 * fallback below. Batch callers (`extract links|--stale --source db`)
 * build the live slug set once already (`allSlugs`), so passing it here is
 * free.
 *
 * Resolution per match:
 *   - substitute the pattern's captures into `rule.target` (`$1`, `$2`, …),
 *     lowercased (every stored slug is lowercase);
 *   - a template with no trailing `*` must equal a live slug EXACTLY;
 *   - a template ending in `*` is a prefix match: resolves only when
 *     exactly one live slug has that prefix (0 matches → skip silently,
 *     ≥2 → skip + count as ambiguous, never guess).
 *
 * Runs under the shared per-page `PageRegexBudget` when supplied (the same
 * budget `inferLinkTypeFromPack` degrades against), so a pathological
 * pack can't blow the page's cumulative ReDoS budget via this path either.
 */
export function resolveIdentifierLinksFromPack(
  pack: Pick<SchemaPackManifest, 'identifier_links'>,
  text: string,
  liveSlugs: ReadonlySet<string> | undefined,
  budget?: PageRegexBudget,
): IdentifierLinkResolution {
  const candidates: IdentifierLinkMatch[] = [];
  let ambiguousCount = 0;
  if (!liveSlugs || pack.identifier_links.length === 0) {
    return { candidates, ambiguousCount };
  }

  for (const rule of pack.identifier_links) {
    let matches: RegExpMatchArray[];
    if (budget) {
      const result = budget.runBoundedAll(rule.name, rule.pattern, text);
      if (result === undefined) break; // page budget exhausted — stop, like inferLinkTypeFromPack does
      matches = result;
    } else {
      // No budget provided (test contexts) — still route through the
      // bounded executor, mirroring inferLinkTypeFromPack's no-budget
      // branch: the input-length cap + catastrophic-shape refusal apply.
      try {
        matches = runRegexBoundedAll(rule.pattern, text);
      } catch {
        continue; // malformed/oversize/catastrophic pattern — skip this rule
      }
    }
    for (const m of matches) {
      if (m.index === undefined) continue;
      const target = substituteCaptures(rule.target, m).toLowerCase();
      const resolved = resolveIdentifierTarget(target, liveSlugs);
      if (resolved === 'ambiguous') { ambiguousCount++; continue; }
      if (resolved === null) continue;
      candidates.push({
        targetSlug: resolved,
        linkType: rule.link_type,
        matchText: m[0],
        index: m.index,
        ruleName: rule.name,
      });
    }
  }
  return { candidates, ambiguousCount };
}

/**
 * `$1`, `$2`, … substitution — same semantics as `String.prototype.replace`'s
 * numbered-group form. Named capture groups (`(?<year>\d+)`) are not yet
 * interpolated (`$<year>`); numbered groups cover the documented use cases
 * (DECISION-$1, SPA-$1). A future rule can add `$<name>` support without a
 * breaking change to this function's contract.
 */
function substituteCaptures(template: string, match: RegExpMatchArray): string {
  return template.replace(/\$(\d+)/g, (_full, n: string) => match[Number(n)] ?? '');
}

/**
 * Resolve one substituted target template against the live slug set.
 * Linear scan on the prefix (`*`) branch — acceptable for the identifier
 * volumes these rules are meant for (a page cites a handful of decisions,
 * not thousands); a brain wanting to lean on this heavily with a very
 * large slug set is a candidate for a maintained prefix index, not
 * implemented here.
 */
function resolveIdentifierTarget(
  target: string,
  liveSlugs: ReadonlySet<string>,
): string | 'ambiguous' | null {
  if (!target.endsWith('*')) {
    return liveSlugs.has(target) ? target : null;
  }
  const prefix = target.slice(0, -1);
  if (prefix.length === 0) return null; // refuse to "resolve" against every slug in the brain
  let found: string | null = null;
  for (const slug of liveSlugs) {
    if (!slug.startsWith(prefix)) continue;
    if (found !== null) return 'ambiguous';
    found = slug;
  }
  return found;
}
