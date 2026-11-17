/**
 * Classifies one mirrored read (plan PR S1). Pure: the child calls it with the primary's encoded result and the
 * Rust engine's outcome.
 *
 *   match              equal canonical JSON
 *   order_diff         a ranked read with the same rows in another order (scores ignored)
 *   diff               anything else that differs
 *   privacy_diverged   a Rust row whose source_id is outside the scope the call asked for (sourceId / sourceIds)
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
  | 'match' | 'order_diff' | 'diff' | 'privacy_diverged'
  | 'capability_missing' | 'error' | 'timeout' | 'addon_unavailable';

export const SHADOW_OUTCOMES: readonly ShadowOutcome[] = [
  'match', 'order_diff', 'diff', 'privacy_diverged', 'capability_missing', 'error', 'timeout', 'addon_unavailable',
];

export interface Classification {
  outcome: ShadowOutcome;
  reason?: string;
}

/** Score-like fields two rankers may legitimately compute differently; ignored by the order-insensitive pass. */
const SCORE_FIELDS = new Set(['score', 'rank', 'similarity', 'distance', 'rrf_score', 'ts_rank']);

/** The source scope a read asked for, from its options argument; null when unscoped. */
export function requestedSourceScope(args: unknown[]): Set<string> | null {
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue;
    const rec = arg as Record<string, unknown>;
    if (Array.isArray(rec.sourceIds) && rec.sourceIds.length > 0) return new Set(rec.sourceIds.filter((s): s is string => typeof s === 'string'));
    if (typeof rec.sourceId === 'string' && rec.sourceId) return new Set([rec.sourceId]);
  }
  return null;
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

/** First source_id on a Rust row outside `scope`, or null. */
export function outOfScopeSource(encodedRust: unknown, scope: Set<string> | null): string | null {
  if (!scope) return null;
  for (const row of rowsOf(encodedRust)) {
    if (!row || typeof row !== 'object') continue;
    const source = (row as Record<string, unknown>).source_id;
    if (typeof source === 'string' && !scope.has(source)) return source;
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
export function classifyResult(kind: ShadowReadKind, args: unknown[], encodedPrimary: unknown, encodedRust: unknown): Classification {
  const leaked = outOfScopeSource(encodedRust, requestedSourceScope(args));
  if (leaked !== null) return { outcome: 'privacy_diverged', reason: 'row_outside_requested_sources' };
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
