/**
 * Classifies one mirrored read (plan PR S1). Pure: the child calls it with the primary's encoded result and the
 * Rust engine's outcome.
 *
 *   match              equal canonical JSON
 *   order_diff         a ranked read with the same rows in another order (scores ignored)
 *   diff               anything else that differs (on an exactness comparison, exactness.ts turns it into stale or inconclusive)
 *   stale              an exactness mismatch while the follower held older committed work it had not applied
 *   inconclusive       an exactness mismatch with no such evidence; counted as unexplained until a rerun exists
 *   collation_order    a text-ordered read whose rows are the primary's, in C byte order (exactness.ts); explained, not unexplained
 *   privacy_diverged   a Rust row outside the call's source scope (any source column it carries), or a private page the call excluded
 *   capability_missing Rust refused with engine_capability_missing; `reason` is the capability
 *   error              Rust threw anything else; `reason` is its code when it has one
 *   timeout            Rust did not answer in the child's per-call budget
 *   addon_unavailable  the child could not load the addon; `reason` is the loader code
 *
 * Privacy is checked before equality, on every row of the Rust result, and is never sampled within a response.
 */
import { canonicalJson } from './codec.ts';
import type { ShadowReadKind } from './reads.ts';

export type ShadowOutcome =
  | 'match' | 'order_diff' | 'diff' | 'stale' | 'inconclusive' | 'collation_order' | 'privacy_diverged'
  | 'capability_missing' | 'error' | 'timeout' | 'addon_unavailable';

export const SHADOW_OUTCOMES: readonly ShadowOutcome[] = [
  'match', 'order_diff', 'diff', 'stale', 'inconclusive', 'collation_order', 'privacy_diverged', 'capability_missing', 'error', 'timeout', 'addon_unavailable',
];

export interface Classification {
  outcome: ShadowOutcome;
  reason?: string;
  /** For stale, inconclusive and collation_order: the mismatch the comparison found. */
  mismatch?: 'diff' | 'order_diff';
}

/** Score-like fields two rankers may legitimately compute differently; ignored by the order-insensitive pass. */
const SCORE_FIELDS = new Set(['score', 'rank', 'similarity', 'distance', 'rrf_score', 'ts_rank']);

/** Reads that take their source by position, not in an options object: the index of the string (or list) naming it. */
const POSITIONAL_SCOPE: Readonly<Record<string, number>> = { listFactsByEntity: 0, resolveSlugWithAlias: 1, findByTitleFuzzy: 3 };

/** The columns a row can carry its source in; a link carries one per page it joins. */
const SOURCE_COLUMNS = ['source_id', 'from_source_id', 'to_source_id', 'origin_source_id'] as const;
/** A one-source link read scopes one end only (the primary returns the far end across sources): getLinks its from page, getBacklinks its to page. */
const LINK_SCOPED_END: Readonly<Record<string, string>> = { getLinks: 'from_source_id', getBacklinks: 'to_source_id' };

export interface SourceScope { ids: Set<string>; federated: boolean; op?: string }

/** The source scope a read asked for, read as the primary applies it (list > single > none; an empty list with no single source allows nothing). */
export function requestedSourceScope(args: unknown[], op?: string): SourceScope | null {
  const at = op === undefined ? undefined : POSITIONAL_SCOPE[op];
  const positional = at === undefined ? undefined : args[at];
  if (typeof positional === 'string' && positional) return { ids: new Set([positional]), federated: false, op };
  if (Array.isArray(positional)) return { ids: new Set(positional.filter((s): s is string => typeof s === 'string')), federated: true, op };
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
    const rec = arg as Record<string, unknown>;
    const single = typeof rec.sourceId === 'string' && rec.sourceId ? rec.sourceId : null;
    if (Array.isArray(rec.sourceIds)) {
      const ids = rec.sourceIds.filter((s): s is string => typeof s === 'string' && s !== '');
      if (ids.length > 0) return { ids: new Set(ids), federated: true, op };
      return single ? { ids: new Set([single]), federated: false, op } : { ids: new Set(), federated: true, op };
    }
    if (single) return { ids: new Set([single]), federated: false, op };
  }
  return null;
}

/** True when the call asked to hide private rows (`excludePrivate` on its options, or on a find's `untrusted` policy). */
export function requestedExcludePrivate(args: unknown[]): boolean {
  return args.some((arg) => {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return false;
    const rec = arg as { excludePrivate?: unknown; untrusted?: { excludePrivate?: unknown } | null };
    return rec.excludePrivate === true || rec.untrusted?.excludePrivate === true;
  });
}

function rowsOf(encoded: unknown): unknown[] {
  if (Array.isArray(encoded)) return encoded;
  if (encoded && typeof encoded === 'object') {
    const rec = encoded as Record<string, unknown>;
    for (const key of ['rows', 'pages', 'results', 'items']) if (Array.isArray(rec[key])) return rec[key] as unknown[];
    return [encoded];
  }
  return [];
}

/** A page row the primary's `excludePrivate` hides: visibility private, a pinned question, or an unmarked derived page (isPrivacyPrivatePage). */
function isPrivateRow(row: Record<string, unknown>): boolean {
  const fm = row.frontmatter && typeof row.frontmatter === 'object' ? row.frontmatter as Record<string, unknown> : null;
  if (!fm) return false;
  const derived = row.type === 'atom' || row.type === 'question' || (row.type === 'concept' && fm.synthesized_by != null);
  return fm.pinned_question != null || (fm.visibility ?? (derived ? 'private' : 'world')) === 'private';
}

/** Why a Rust row leaks: a source outside `scope` in any column the row carries, or a page `excludePrivate` hides; null when none does. */
export function leakReason(encodedRust: unknown, scope: SourceScope | null, excludePrivate = false): 'row_outside_requested_sources' | 'private_row_returned' | null {
  const columns = scope && !scope.federated && scope.op && LINK_SCOPED_END[scope.op] ? [LINK_SCOPED_END[scope.op]] : SOURCE_COLUMNS;
  for (const row of rowsOf(encodedRust)) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    if (excludePrivate && isPrivateRow(rec)) return 'private_row_returned';
    if (!scope) continue;
    for (const column of columns) {
      const source = rec[column];
      if (typeof source === 'string' && !scope.ids.has(source)) return 'row_outside_requested_sources';
    }
  }
  return null;
}

function stripScores(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) if (!SCORE_FIELDS.has(key)) out[key] = value;
  return out;
}

function sameMultiset(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map((row) => canonicalJson(stripScores(row))).sort();
  const right = b.map((row) => canonicalJson(stripScores(row))).sort();
  return left.every((value, i) => value === right[i]);
}

/** Compares a successful Rust result with the primary's. Both are already encoded (codec.ts). */
export function classifyResult(kind: ShadowReadKind, args: unknown[], encodedPrimary: unknown, encodedRust: unknown, op?: string): Classification {
  const leaked = leakReason(encodedRust, requestedSourceScope(args, op), requestedExcludePrivate(args));
  if (leaked !== null) return { outcome: 'privacy_diverged', reason: leaked };
  if (canonicalJson(encodedPrimary) === canonicalJson(encodedRust)) return { outcome: 'match' };
  if (kind === 'ranked' && Array.isArray(encodedPrimary) && Array.isArray(encodedRust) && sameMultiset(encodedPrimary, encodedRust)) {
    return { outcome: 'order_diff' };
  }
  return { outcome: 'diff' };
}

/** Classifies a Rust call that threw. */
export function classifyError(error: unknown): Classification {
  const rec = (error && typeof error === 'object' ? error : {}) as { code?: unknown; reason?: unknown };
  if (rec.code === 'engine_capability_missing') {
    return { outcome: 'capability_missing', ...(typeof rec.reason === 'string' ? { reason: rec.reason } : {}) };
  }
  return { outcome: 'error', reason: typeof rec.code === 'string' ? rec.code : 'unknown' };
}
