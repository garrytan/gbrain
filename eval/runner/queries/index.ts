/**
 * Aggregates all tier-5/5.5 query sets and exposes validator helpers.
 *
 * Usage:
 *   import { getAllTierQueries, validateAll } from './queries';
 *   const queries = getAllTierQueries();
 *   const result = validateAll(queries);
 */

import type { Query } from '../types.ts';
import { getTier5FuzzyQueries } from './tier5-fuzzy.ts';
import { getTier5_5SyntheticQueries } from './tier5_5-synthetic.ts';
import { validateQuerySet, formatIssues } from './validator.ts';

/** Tier 5 Fuzzy/Vibe (hand-authored by gstack maintainers). */
export { getTier5FuzzyQueries } from './tier5-fuzzy.ts';

/** Tier 5.5 externally-authored (SYNTHETIC placeholder; see CONTRIBUTING.md). */
export { getTier5_5SyntheticQueries } from './tier5_5-synthetic.ts';

export { validateQuery, validateQuerySet, formatIssues, TEMPORAL_VERBS } from './validator.ts';
export type { ValidationIssue, ValidationResult } from './validator.ts';

/** All Tier 5 + 5.5 queries concatenated. */
export function getAllTierQueries(): Query[] {
  return [...getTier5FuzzyQueries(), ...getTier5_5SyntheticQueries()];
}

/** Validate the complete Tier-5 + 5.5 set (used by CI + eval:query:validate). */
export function validateAll(): { ok: boolean; count: number; report: string } {
  const queries = getAllTierQueries();
  const result = validateQuerySet(queries);
  return {
    ok: result.ok,
    count: queries.length,
    report: formatIssues(result),
  };
}
