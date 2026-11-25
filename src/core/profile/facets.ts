/**
 * Lane 3 P1: the portable profile's facets. A profile fact is an ordinary fact on the caller's own entity page whose
 * typed claim metric is `profile.<facet>`, from the fixed list below. This module is the one place that prefix is
 * validated: remember (facet, and a hand-written claim_metric), the facts-fence codec (normalizeMetricLabel) and the
 * extractor's labels (normalizeExtractedMetricLabel) all ask it, so only remember's facet creates a profile row.
 * Pure and import-free, so the fence codec can load it; refusals and routing live in remember.ts.
 */

export const PROFILE_METRIC_PREFIX = 'profile.';
/** size takes an item (size.shoe); every other facet stands alone. */
export const PROFILE_FACETS = ['size', 'brand', 'diet', 'allergy', 'style', 'constraint', 'schedule', 'household', 'other'] as const;
export type ProfileFacet = (typeof PROFILE_FACETS)[number];
/** Facets saved private unless the call names a visibility or share. */
export const PRIVATE_BY_DEFAULT_FACETS: readonly ProfileFacet[] = ['allergy'];
/** Facets a profile read returns as constraints rather than preferences. */
export const CONSTRAINT_FACETS: readonly ProfileFacet[] = ['allergy', 'constraint'];

const ITEM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The canonical facet a label names (`diet`, `size.shoe`), or null when it names none. */
export function canonicalFacet(raw: string): string | null {
  const label = raw.trim().toLowerCase();
  const [head, ...rest] = label.split('.');
  if (head === 'size') return rest.length === 1 && ITEM_RE.test(rest[0]!) ? label : null;
  return rest.length === 0 && (PROFILE_FACETS as readonly string[]).includes(head!) ? label : null;
}

/** The top-level facet of a canonical facet (`size.shoe` → `size`). */
export const facetKind = (facet: string): ProfileFacet => facet.split('.')[0] as ProfileFacet;

export const isProfileMetricLabel = (label: string | null | undefined): boolean =>
  typeof label === 'string' && label.trim().toLowerCase().startsWith(PROFILE_METRIC_PREFIX);

/** The facet a stored claim metric carries (`profile.diet` → `diet`), or null for any other metric or an invalid facet. */
export function facetOfMetric(metric: string | null | undefined): string | null {
  if (!isProfileMetricLabel(metric)) return null;
  return canonicalFacet(metric!.trim().slice(PROFILE_METRIC_PREFIX.length));
}

