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
 *
 * One mismatch is explained instead: `collation_order`. A read whose output is ordered by text (the table below gives
 * each one's text key) answers in the host's collation on a Postgres primary, while Rust follows PGLite's C byte order by
 * design (RUST_ENGINE.md "Exactness hazards"; ICU and glibc hosts sort differently). Same rows in Rust's C order is that,
 * not a divergence and counts as successful coverage (evidence.ts); any other difference keeps the stale / inconclusive rule.
 */
import type { Classification } from './classify.ts';
import { canonicalJson } from './codec.ts';
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
export function qualifyMismatch(op: string, c: Classification, lagged: boolean, sample?: ReadSample): Classification {
  if ((c.outcome !== 'diff' && c.outcome !== 'order_diff') || exactnessArm(op) === null) return c;
  if (sample && isCollationOrder(op, sample.args, sample.primary, sample.rust)) return { outcome: 'collation_order', mismatch: c.outcome };
  return { outcome: lagged ? 'stale' : 'inconclusive', mismatch: c.outcome };
}

/** One comparison's encoded call arguments and both encoded results. */
export interface ReadSample { args: unknown; primary: unknown; rust: unknown }

type TextKey = (row: unknown) => string[] | null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const field = (row: unknown, name: string): string | null => (row && typeof row === 'object' ? str((row as Record<string, unknown>)[name]) : null);

/** The reads ordered by text, each with the text key of one row for these arguments (null: not text-ordered for them). */
const TEXT_ORDERED: Readonly<Record<string, (args: unknown) => TextKey | null>> = {
  // ORDER BY tag
  getTags: () => (row) => { const t = str(row); return t === null ? null : [t]; },
  // PAGE_SORT_SQL.slug: p.slug, p.source_id; the other sorts order by time.
  listPages: (args) => {
    const sorted = Array.isArray(args) && args.some((a) => a && typeof a === 'object' && (a as Record<string, unknown>).sort === 'slug');
    return sorted ? (row) => { const [s, src] = [field(row, 'slug'), field(row, 'source_id')]; return s === null || src === null ? null : [s, src]; } : null;
  },
};

const byBytes = (a: string[], b: string[]): number => {
  for (let i = 0; i < a.length; i++) { const d = Buffer.compare(Buffer.from(a[i]!), Buffer.from(b[i]!)); if (d !== 0) return d; }
  return 0;
};

/**
 * True when Rust's answer is exactly the primary's rows re-sorted by the operation's text key in C byte order (UTF-8
 * bytes, not JavaScript string order) and differs from the primary's own order. Equal answers are matches, never this.
 */
export function isCollationOrder(op: string, args: unknown, primary: unknown, rust: unknown): boolean {
  if (!Object.prototype.hasOwnProperty.call(TEXT_ORDERED, op) || !Array.isArray(primary) || !Array.isArray(rust)) return false;
  const key = TEXT_ORDERED[op]!(args);
  if (!key) return false;
  const keyed = primary.map((row) => ({ row, k: key(row) }));
  if (keyed.some((x) => x.k === null)) return false;
  const sorted = keyed.sort((x, y) => byBytes(x.k!, y.k!)).map((x) => x.row); // Array.prototype.sort is stable
  return canonicalJson(sorted) === canonicalJson(rust) && canonicalJson(primary) !== canonicalJson(rust);
}
