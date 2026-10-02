/**
 * The ONE canonical protection predicate for decide slots that can remove or
 * demote a search result (S3 evidence gate, S5 injection demotion): identity
 * evidence (alias hit, structural exact lookup, exact title match) and pinned
 * relational graph answers are never pruned or demoted.
 *
 * Autocut keeps its own preserve predicate (alias hit, exact lookup,
 * relational pin) byte-for-byte, because widening it would change all-off
 * output; this predicate is a superset of it.
 */
import type { SearchResult } from '../../types.ts';

/** Bumped when the predicate changes (part of the policy fingerprint). */
export const PROTECTION_VERSION = 1;

export type ProtectionReason = 'alias_hit' | 'exact_lookup' | 'exact_title_match' | 'relational_pinned';

export function protectionReason(r: Pick<SearchResult, 'alias_hit' | 'exact_lookup' | 'evidence' | 'relational_pinned'>): ProtectionReason | null {
  if (r.alias_hit === true || r.evidence === 'alias_hit') return 'alias_hit';
  if (r.exact_lookup !== undefined) return 'exact_lookup';
  if (r.evidence === 'exact_title_match') return 'exact_title_match';
  if (r.relational_pinned === true) return 'relational_pinned';
  return null;
}

export function isProtectedResult(r: Pick<SearchResult, 'alias_hit' | 'exact_lookup' | 'evidence' | 'relational_pinned'>): boolean {
  return protectionReason(r) !== null;
}
