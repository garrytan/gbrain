/**
 * Which shadow comparisons must match exactly (plan decision 2, review F7): ONE table, so the child, the counters and
 * the report never keep their own lists.
 *
 *   exact          every `exact` member of reads.ts
 *   trigram        findByTitleFuzzy
 *   keyword_title  searchKeyword, searchKeywordChunks, searchTitles, while the Rust ranker is `ts_rank`
 *
 * On these, EVERY mismatch (a different row set, order only, score only) goes through the stale / inconclusive rule
 * below. Vector and take searches stay `ranked`: their order differences are reported, never counted.
 */
import type { Classification } from './classify.ts';
import { SHADOW_READ_MEMBERS } from './reads.ts';

/** Bump when classify.ts or this table changes what counts as a match: it starts a new evidence epoch. */
export const SHADOW_COMPARATOR_VERSION = 1;
/** The only keyword ranker Rust has (D5); the status names it so a better default ranker is a visible change. */
export const SHADOW_KEYWORD_RANKER = 'ts_rank' as const;

export type ExactnessArm = 'exact' | 'trigram' | 'keyword_title';

const SEARCH_ARMS: Readonly<Record<string, ExactnessArm>> = {
  findByTitleFuzzy: 'trigram', searchKeyword: 'keyword_title', searchKeywordChunks: 'keyword_title', searchTitles: 'keyword_title',
};

/** The exactness arm of an operation, or null when its differences are reported and not counted. */
export function exactnessArm(op: string): ExactnessArm | null {
  if (Object.prototype.hasOwnProperty.call(SEARCH_ARMS, op)) return SEARCH_ARMS[op]!;
  return Object.prototype.hasOwnProperty.call(SHADOW_READ_MEMBERS, op) && (SHADOW_READ_MEMBERS as Record<string, string>)[op] === 'exact' ? 'exact' : null;
}

/**
 * A mismatch on an exactness comparison is `stale` only when the child's follower held committed work older than the
 * read that it had not applied yet (`lagged`); otherwise it is `inconclusive`. The original mismatch stays in
 * `mismatch`. Neither is successful coverage. Until the stable rerun exists (plan a2), every inconclusive mismatch counts
 * as unexplained (evidence.ts). Matches, errors and comparisons outside the table pass through unchanged.
 */
export function qualifyMismatch(op: string, c: Classification, lagged: boolean): Classification {
  if ((c.outcome !== 'diff' && c.outcome !== 'order_diff') || exactnessArm(op) === null) return c;
  return { outcome: lagged ? 'stale' : 'inconclusive', mismatch: c.outcome };
}
