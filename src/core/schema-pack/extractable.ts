// v0.38 T7d: pack-driven facts-eligibility types.
//
// Pre-v0.38: src/core/facts/eligibility.ts hardcoded:
//   const ELIGIBLE_TYPES = ['note', 'meeting', 'slack', 'email',
//                            'calendar-event', 'source', 'writing']
// plus RESCUE_SLUG_PREFIXES = ['meetings/', 'personal/', 'daily/'].
//
// v0.38 T7d: the active schema pack declares which types are
// `extractable: true`. gbrain-base preserves the 7 legacy types so
// existing facts extraction behavior is byte-for-byte unchanged.
// User packs (research-state, legal, …) override by setting
// `extractable: true` on their domain-specific types — e.g. a paper
// pack marks `claim` and `finding` as extractable so the backstop
// fires on those pages.
//
// Usage (when callers wire this in Phase B):
//
//   const eligible = extractableTypesFromPack(activePack);
//   if (!eligible.has(parsed.type)) { ... }
//
// Until the wiring lands, legacy facts/eligibility.ts callers continue
// to use the hardcoded ELIGIBLE_TYPES list — which gbrain-base also
// declares, so behavior is preserved.

import type { SchemaPackManifest } from './manifest-v1.ts';

/**
 * Return the Set of pack-declared types with `extractable: true`.
 * Set return shape (vs array) because callers want O(1) membership
 * checks in the eligibility predicate, which fires on every put_page.
 */
export function extractableTypesFromPack(
  pack: Pick<SchemaPackManifest, 'page_types'>,
): Set<string> {
  return new Set(
    pack.page_types
      .filter(pt => pt.extractable === true)
      .map(pt => pt.name),
  );
}

/**
 * Convenience predicate: is this type facts-extractable per the
 * active pack? Avoids creating a Set on every call when the caller
 * only has a manifest, not a precomputed Set.
 */
export function isExtractableType(
  pack: Pick<SchemaPackManifest, 'page_types'>,
  type: string,
): boolean {
  return pack.page_types.some(pt => pt.name === type && pt.extractable === true);
}
