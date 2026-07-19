/**
 * eval-contradictions/dismissals — per-pair manual-review ledger.
 *
 * The probe's judge can only classify; it cannot remember that a human
 * already reviewed a finding and ruled it a false positive. Without a
 * ledger, every reviewed HIGH resurfaces in `doctor`, `review`, the MCP
 * `find_contradictions` surface, and the synthesize prior block on every
 * run — `resolution_kind: 'manual_review'` had nowhere to record its
 * outcome.
 *
 * Identity — versioned, domain-separated, judge-config-independent:
 *   - `pair_key` = sha256 over a domain tag + the pair `kind` + the sorted
 *     content hashes of both member texts (order-independent). Full 64 hex
 *     is the DB identity; the first 12 hex (`pair_id`) is the display/CLI
 *     handle, resolved by prefix with ambiguity rejection.
 *   - model_id / prompt_version / truncation_policy are deliberately NOT
 *     part of the identity: a human verdict about two statements outlives
 *     judge model and prompt changes. To force re-evaluation after a judge
 *     upgrade, `undismiss` explicitly — auditable, unlike silent expiry.
 *   - The identity IS invalidated by content: when either statement's text
 *     changes, its hash changes, the pair stops matching the ledger, and it
 *     re-flags automatically. That hash drift is the expiry policy; rows
 *     carry no TTL.
 *   - The identity is content-level, not occurrence-level: if the same two
 *     texts appear under multiple slugs/sources, one dismissal covers all
 *     occurrences. This is intentional — the human judged the STATEMENTS,
 *     not their location.
 *
 * Lifecycle — soft-state, not delete:
 *   - `undismiss` stamps `undismissed_at` instead of deleting, so the
 *     ledger stays an audit trail. Active rows are `undismissed_at IS
 *     NULL`; re-dismissing reactivates the row (overwriting reason —
 *     acceptable single-row history for this scope).
 *
 * Enforcement — one shared read-time projection:
 *   `projectContradictionFindings` recomputes each finding's pair_key from
 *   its kind + member texts (works for report rows written before findings
 *   carried `pair_id`) and partitions against the active ledger. All four
 *   read surfaces (probe runner, doctor check, `review` CLI, MCP
 *   `find_contradictions`, synthesize prior block) route through it so a
 *   dismissal takes effect everywhere immediately — without paying for a
 *   fresh probe run.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { hashContent } from './cache.ts';

/**
 * Domain separation + identity versioning. Bumping the version changes
 * every pair_key, cleanly orphaning old ledger rows if the identity scheme
 * ever needs to change shape.
 */
export const PAIR_KEY_DOMAIN = 'gbrain:contradiction-pair:v1';

/** Display/CLI handle length: enough hex to be unambiguous at brain scale. */
export const PAIR_ID_DISPLAY_LEN = 12;

/** One active ledger row, as stored. */
export interface DismissalRow {
  pair_key: string;
  kind: string;
  chunk_a_hash: string;
  chunk_b_hash: string;
  reason: string;
  dismissed_by: string | null;
  dismissed_at: string;
}

/** Sorted (order-independent) content-hash pair for two member texts. */
export function dismissalHashPair(textA: string, textB: string): {
  chunk_a_hash: string;
  chunk_b_hash: string;
} {
  const hA = hashContent(textA);
  const hB = hashContent(textB);
  const [first, second] = hA <= hB ? [hA, hB] : [hB, hA];
  return { chunk_a_hash: first, chunk_b_hash: second };
}

/** Full 64-hex ledger identity for a (kind, textA, textB) triple. */
export function contradictionPairKey(kind: string, textA: string, textB: string): string {
  const { chunk_a_hash, chunk_b_hash } = dismissalHashPair(textA, textB);
  return createHash('sha256')
    .update(`${PAIR_KEY_DOMAIN}\0${kind}\0${chunk_a_hash}\0${chunk_b_hash}`, 'utf8')
    .digest('hex');
}

/** Display prefix of a full pair_key. */
export function pairIdFromKey(pairKey: string): string {
  return pairKey.slice(0, PAIR_ID_DISPLAY_LEN);
}

/** Convenience: display handle straight from the triple. */
export function computePairId(kind: string, textA: string, textB: string): string {
  return pairIdFromKey(contradictionPairKey(kind, textA, textB));
}

/**
 * Recompute a finding's full pair_key from its own content. Accepts the
 * loosely-typed shapes that report_json consumers work with (doctor / MCP /
 * synthesize cast partial views); returns null when the finding predates
 * member texts in the report — such findings can never match the ledger and
 * always surface.
 */
export function computeFindingPairKey(finding: unknown): string | null {
  if (!finding || typeof finding !== 'object') return null;
  const f = finding as { kind?: unknown; a?: { text?: unknown }; b?: { text?: unknown } };
  if (typeof f.kind !== 'string') return null;
  const textA = f.a?.text;
  const textB = f.b?.text;
  if (typeof textA !== 'string' || typeof textB !== 'string') return null;
  return contradictionPairKey(f.kind, textA, textB);
}

/** Active ledger rows (undismissed_at IS NULL), straight from the engine. */
export async function loadDismissals(engine: BrainEngine): Promise<DismissalRow[]> {
  return engine.listContradictionDismissals();
}

/** Set of full pair_keys for O(1) membership tests. */
export function activePairKeySet(rows: DismissalRow[]): Set<string> {
  return new Set(rows.map((r) => r.pair_key));
}

/**
 * The shared read-time projection: split findings into surfaced vs
 * dismissed by recomputing each finding's pair_key against the active
 * ledger. Generic so every consumer keeps its own (partial) finding shape.
 */
export function projectContradictionFindings<T>(
  findings: T[],
  activeKeys: Set<string>,
): { surfaced: T[]; dismissed: T[] } {
  const surfaced: T[] = [];
  const dismissed: T[] = [];
  for (const f of findings) {
    const key = computeFindingPairKey(f);
    if (key !== null && activeKeys.has(key)) dismissed.push(f);
    else surfaced.push(f);
  }
  return { surfaced, dismissed };
}

/**
 * Best-effort active-key loader for read surfaces. Fail-open to an empty
 * set: a ledger read error (e.g. pre-migration brain) must never take down
 * a paid probe run, the doctor check, or a dream cycle — it only means
 * nothing gets suppressed on this read.
 */
export async function loadActivePairKeySetBestEffort(engine: BrainEngine): Promise<Set<string>> {
  try {
    return activePairKeySet(await loadDismissals(engine));
  } catch {
    return new Set();
  }
}
