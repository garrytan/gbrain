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
import { PageRegexBudget, runRegexBounded } from './redos-guard.ts';

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

// #3190 — pack-aware plain link extraction.
//
// The codegen'd base packs are generated FROM the in-code tables
// (inferLinkType's production regexes + FRONTMATTER_LINK_MAP + the
// DIR_PATTERN dirs — see scripts/generate-gbrain-base.ts). Consulting them
// at extraction time would double-apply WORSE copies of the same semantics:
// the YAML carries simplified sketch regexes, and its frontmatter_links
// entries have no direction field (the hardcoded map's `incoming` entries
// like key_people would come back reversed). Custom packs are the ones
// extraction must honor.
const CODEGEN_BASE_PACKS = new Set(['gbrain-base', 'gbrain-base-v2']);

/**
 * The slice of a resolved pack that plain link extraction
 * (`extractPageLinks` / `extractFrontmatterLinks`) consumes.
 */
export interface PackLinkExtraction {
  link_types: SchemaPackManifest['link_types'];
  frontmatter_links: SchemaPackManifest['frontmatter_links'];
  /**
   * Entity-dir alternatives derived from `page_types[].path_prefixes`
   * (leading/trailing slashes stripped). Unioned into DIR_PATTERN so
   * markdown/wikilink targets under pack-declared layouts (e.g.
   * `wiki/people/…`) become extraction candidates.
   */
  entity_dirs: string[];
}

/**
 * Project a resolved active pack down to what link extraction needs.
 * Returns null (extraction stays purely legacy) when there is no pack or
 * the pack is one of the codegen'd base packs.
 */
export function packLinkExtractionView(
  pack: { manifest: SchemaPackManifest } | null | undefined,
): PackLinkExtraction | null {
  const m = pack?.manifest;
  if (!m || CODEGEN_BASE_PACKS.has(m.name)) return null;
  const dirs = new Set<string>();
  for (const pt of m.page_types) {
    for (const prefix of pt.path_prefixes ?? []) {
      const d = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
      // Only slug-shaped prefixes participate in regex union; anything
      // else (globs, regex metachars) is skipped rather than escaped so
      // the entity regexes stay predictable.
      if (d && /^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(d)) dirs.add(d);
    }
  }
  return {
    link_types: m.link_types,
    frontmatter_links: m.frontmatter_links,
    entity_dirs: [...dirs],
  };
}
