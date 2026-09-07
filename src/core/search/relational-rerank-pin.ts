/**
 * relational-rerank-pin.ts — relational-arm rows bypass reranker DEMOTION.
 *
 * WHY. The cross-encoder scores chunk TEXT against the query. The relational
 * arm's rows (relational-recall.ts `buildRelationalArm`, fused as the fourth
 * RRF list in fusion-lists.ts) are typed-EDGE answers: "who invested in
 * acme-co" resolves to investor pages whose text need not mention acme-co at
 * all — only the `invested_in` edge connects them. A reranker therefore ranks
 * them below any page that merely contains the query's words. NamedThingBench
 * relational fixture (39 graph-relationship questions), shipped `balanced`
 * default, receipt R1 (`scripts/r1-namedthing-rerank-ab.ts`): reranker OFF
 * hit@1 21/39 · hit@3 27/39; reranker ON hit@1 3/39 · hit@3 5/39 — 19 hit@1
 * losses, 22 hit@3 losses, 0 wins on the 11 non-relational core questions.
 * `ensureRelationalEvidenceSlot` (#3995) keeps ONE relational row on page 1
 * (slot `limit-1`), which is not enough for hit@1 / hit@3.
 *
 * WHAT. After `applyReranker`, the relational rows already in the pool are
 * re-pinned ABOVE the reranked text rows, in their fused (RRF) order, bounded
 * by `relational_rerank_pin` rows (ModeBundle knob, config
 * `search.relational_rerank_pin`; 3 in every bundle; `0`/`off` disables and
 * reproduces the pre-pin ranking). The pin is a PERMUTATION of the reranked
 * pool: no row is added or removed (re-injection of rows dropped by
 * `topNOut` stays the evidence slot's job), text rows keep their reranked
 * relative order, and pinned rows are stamped `relational_pinned: true` so
 * autocut keeps them through a rerank-score cliff (they carry low scores by
 * construction) and excludes them from its cliff computation.
 *
 * ORDER + TIE POLICY (documented, pinned by test/search/relational-rerank-pin.test.ts):
 *   - a row is "relational" when its page key `(source_id, slug)` appears in
 *     the arm's list; ONE row per page is pinned (the first — highest-ranked —
 *     occurrence in the reranked pool; a second chunk of the same page is an
 *     ordinary text row);
 *   - each relational row's claim = `min(fused_rank, reranked_rank)` where
 *     `fused_rank` is its 0-based rank AMONG relational rows in the pre-rerank
 *     fused pool (`fusedOrder`; falls back to the arm's own order when a row
 *     is absent from it, or when `fusedOrder` is omitted) and `reranked_rank`
 *     is its 0-based position in the reranked pool. "Rows that are both
 *     relational and reranked keep whichever position is higher": a row the
 *     reranker itself promoted to rank 0 keeps that claim;
 *   - claims sort ascending; ties resolve to the FUSED order, then the
 *     reranked position — the pin's premise is that the cross-encoder cannot
 *     judge edge-derived rows, so its opinion may PROMOTE a relational row
 *     past fused-lower rows only when strictly decisive, never re-order the
 *     fused evidence among equals;
 *   - the first `max` claimants form the pinned block at the top, in that
 *     order; every other row (text rows AND any relational rows beyond `max`)
 *     follows in its reranked order. An unpinned row therefore lands at its
 *     reranked position or up to `pinned.length` slots lower — never higher;
 *   - no relational rows in the pool, `max <= 0`, an empty pool or an empty
 *     arm → the INPUT ARRAY (same reference; byte-identical results).
 *
 * WHEN NOT. The caller (hybrid.ts) invokes this only when the reranker
 * actually reordered the pool (`applyReranker` returns its input on every
 * fail-open / skip / pass-through path, and the fused order already carries
 * the arm's rows where RRF put them) and never for image modality (the arm is
 * not fused there). Non-relational queries have an empty arm → no-op.
 *
 * KNOWN COST (honest): the pin trusts the relational arm. A false-positive
 * arm (the parser matched a relational shape AND the seed resolved to a real
 * page, but the edges are wrong or stale) now puts up to `max` edge-derived
 * pages at ranks 1..max instead of one at `limit`. Mitigations: the arm's
 * confidence gate (a `fallback_slugify`-only seed never fires), the tier-2
 * resolution-margin gate filed in TODOS.md, per-brain `search.relational_rerank_pin`
 * (`0`/`off`), and the per-call `SearchOpts.relationalRerankPin` seam.
 *
 * Pure: no engine, no IO, deterministic. Never mutates its inputs (pinned rows
 * are shallow copies carrying the stamp).
 */

import type { SearchResult } from '../types.ts';

/** Inclusive upper bound of the `relational_rerank_pin` range `[0, 10]`. */
export const RELATIONAL_RERANK_PIN_MAX = 10;
/** Bundle default in every mode (the R1 receipt's fix; 3 covers hit@3). */
export const DEFAULT_RELATIONAL_RERANK_PIN = 3;

/**
 * The ONE range contract for `relational_rerank_pin`, shared by the config-key
 * parser (mode.ts `loadOverridesFromConfig`) and the per-call seams in
 * hybrid.ts (inner search AND cache resolver):
 *
 *   - a non-negative integer `<= 10` (or a string that parses to one, e.g.
 *     the config value `'3'`)                          → that integer
 *   - the literals `off` / `false` (any case) or `false` → `0` (disabled)
 *   - anything else (negatives, > 10, fractions, NaN, ±Infinity, `''`, `null`,
 *     `true`, objects, `undefined`)                     → `undefined` (unset:
 *     fall through to the next resolution tier — config → bundle)
 */
export function normalizeRelationalRerankPin(v: unknown): number | undefined {
  if (v === false) return 0;
  if (typeof v === 'string') {
    const lit = v.trim().toLowerCase();
    if (lit === 'off' || lit === 'false') return 0;
    if (lit === '') return undefined;
    return normalizeRelationalRerankPin(Number(lit));
  }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= RELATIONAL_RERANK_PIN_MAX) return v;
  return undefined;
}

/** One pinned row, for `HybridSearchMeta.relational_rerank_pin` (`--explain`). */
export interface RelationalRerankPinnedRow {
  slug: string;
  source_id: string;
  /** 0-based position in the reranked pool (where the cross-encoder left it). */
  from_rank: number;
  /** 0-based position after the pin (its slot in the block). */
  to_rank: number;
  /** 0-based rank among relational rows in the fused (pre-rerank) pool. */
  fused_rank: number;
}

/** Decision stamp surfaced through `HybridSearchMeta.relational_rerank_pin`. */
export interface RelationalRerankPinDecision {
  /** The resolved `relational_rerank_pin` knob. */
  max: number;
  /** Distinct relational pages present in the reranked pool. */
  relational_in_pool: number;
  /** Rows pinned to the top block, in final order. */
  pinned: RelationalRerankPinnedRow[];
  /** How many pinned rows actually changed position. */
  moved: number;
}

export interface PinRelationalRowsOpts {
  /** Resolved `relational_rerank_pin`; `<= 0` disables (input returned as-is). */
  max: number;
  /**
   * The pre-rerank fused pool (hybrid.ts `deduped`). Supplies the fused rank
   * of each relational row; rows absent from it (or all rows when omitted)
   * rank by the arm's own order, after any fused-present rows.
   */
  fusedOrder?: readonly SearchResult[];
  /** Fires once when at least one row was pinned (never on the no-op path). */
  onPin?: (decision: RelationalRerankPinDecision) => void;
}

const pageKey = (r: SearchResult): string => `${r.source_id ?? 'default'}:${r.slug}`;

/**
 * Re-pin relational-arm rows above the reranked text rows. See the module
 * header for the contract; returns `reranked` itself on every no-op path.
 */
export function pinRelationalRows(
  reranked: SearchResult[],
  relationalList: readonly SearchResult[],
  opts: PinRelationalRowsOpts,
): SearchResult[] {
  const max = Number.isFinite(opts.max) ? Math.floor(opts.max) : 0;
  if (max <= 0 || reranked.length === 0 || relationalList.length === 0) return reranked;

  const relKeys = new Set(relationalList.map(pageKey));

  // Fused rank among relational rows: first from the fused pool, then the
  // arm's own order for anything the fused pool did not carry.
  const fusedRank = new Map<string, number>();
  for (const r of opts.fusedOrder ?? []) {
    const k = pageKey(r);
    if (relKeys.has(k) && !fusedRank.has(k)) fusedRank.set(k, fusedRank.size);
  }
  for (const r of relationalList) {
    const k = pageKey(r);
    if (!fusedRank.has(k)) fusedRank.set(k, fusedRank.size);
  }

  // Candidates: one per relational page — its first (highest) reranked row.
  const seen = new Set<string>();
  const candidates: Array<{ idx: number; fused: number; claim: number }> = [];
  for (let i = 0; i < reranked.length; i++) {
    const k = pageKey(reranked[i]);
    if (!relKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    const fused = fusedRank.get(k)!;
    candidates.push({ idx: i, fused, claim: Math.min(fused, i) });
  }
  if (candidates.length === 0) return reranked;

  candidates.sort((a, b) => a.claim - b.claim || a.fused - b.fused || a.idx - b.idx);
  const block = candidates.slice(0, max);
  const blockIdx = new Set(block.map((c) => c.idx));

  const out: SearchResult[] = [];
  const pinned: RelationalRerankPinnedRow[] = [];
  let moved = 0;
  for (const c of block) {
    const row = reranked[c.idx];
    const to = out.length;
    if (to !== c.idx) moved++;
    pinned.push({ slug: row.slug, source_id: row.source_id ?? 'default', from_rank: c.idx, to_rank: to, fused_rank: c.fused });
    out.push({ ...row, relational_pinned: true });
  }
  for (let i = 0; i < reranked.length; i++) {
    if (!blockIdx.has(i)) out.push(reranked[i]);
  }

  try {
    opts.onPin?.({ max, relational_in_pool: candidates.length, pinned, moved });
  } catch {
    // Meta stamping must never break search.
  }
  return out;
}
