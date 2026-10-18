import { digest } from './digest.ts';

export const RECONCILE_SAFETY_KEYS = ['quarantine', 'content_flag', 'embed_skip'];

export function stabilizeSafetyAssessments(frontmatter: Record<string, unknown>, previous: Record<string, unknown>, assessmentAt?: string): void {
  for (const key of RECONCILE_SAFETY_KEYS) {
    const marker = frontmatter[key];
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) continue;
    const prior = previous[key];
    const withoutStamp = (value: unknown) => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'assessed_at')) : value;
    if (prior && digest(withoutStamp(marker)) === digest(withoutStamp(prior))) frontmatter[key] = prior;
    else if (assessmentAt) frontmatter[key] = { ...marker, assessed_at: assessmentAt };
  }
}

/** The gate's own assessments (re-derived from the bytes on every import) are database state, never a reason to rewrite or refuse a canonical file. */
export function withoutSafetyAssessments(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...frontmatter };
  for (const key of RECONCILE_SAFETY_KEYS) delete rest[key];
  return rest;
}
