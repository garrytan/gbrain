/**
 * autocut.ts — score-discontinuity result-sizing on the rerank separatrix (v0.42.3.0).
 *
 * Weaviate-style "autocut": instead of returning a fixed top-K (noisy), cut the
 * ranked list where the score curve breaks. Returns 1 when the answer is obvious,
 * the cluster when it's genuinely several, never K just because K was the limit.
 * Fixes part of issue #1663 (the "20 vs 1" precision problem), recommendation #2.
 *
 * WHY this runs on the cross-encoder rerank score and NOTHING else: gbrain
 * measured (PrecisionMemBench Phase-1, documented in return-policy.ts) that the
 * RRF/cosine rank1→rank2 gap is ~identical whether rank-1 is right (0.602) or
 * wrong (0.569) — mechanical decay, not a trustworthy separatrix. The reranker's
 * relevance score IS a real cliff. So autocut reads rerank_score; the caller
 * gates it on the reranker having actually produced scores (it fails open to RRF
 * order on auth/network/timeout — see hybrid.ts), and autocut itself no-ops when
 * fewer than 2 items carry a finite score.
 *
 * Pure + dependency-light so it unit-tests in isolation. Mirrors return-policy.ts's
 * resolve-ladder shape; the two are deliberately separate modules (different cut
 * signals — score-cliff vs intent-cap) until a third trimmer justifies extraction.
 */

export interface AutocutConfig {
  /** Module-default master switch. The EFFECTIVE enable is the mode-bundle knob
   *  (resolvedMode.autocut) gated on the reranker having scored ≥2 items; the
   *  caller passes `enabled: true` explicitly once that gate passes. */
  enabled: boolean;
  /**
   * Minimum normalized gap (relative to the top score) that counts as a cliff.
   * Eval-derived starting point (calibrated by the PrecisionMemBench run), NOT a
   * magic constant — it's a per-mode ModeBundle knob. Clamped to (0, 1].
   */
  jumpRatio: number;
  /** Failsafe: never return fewer than this when candidates exist (≥1). */
  minKeep: number;
}

/**
 * Defaults. enabled=true here is the MODULE default; whether autocut actually
 * fires is decided by the mode bundle + the reranker-scored-prefix gate in
 * hybrid.ts. jumpRatio=0.20 means "a drop of ≥20% of the top score is a cliff."
 */
export const DEFAULT_AUTOCUT: AutocutConfig = Object.freeze({
  enabled: true,
  jumpRatio: 0.2,
  minKeep: 1,
});

export interface AutocutDecision {
  applied: boolean;
  /** 'rerank' when a real cliff was cut; 'none' when no cut (no signal / no cliff). */
  signal: 'rerank' | 'none';
  /** Number of items kept (the cut point). */
  cut: number;
  kept: number;
  total: number;
  /** The largest normalized gap observed (0 when <2 scored items). */
  gapRatio: number;
}

/** Per-call SearchOpts shape: `true`/`false` toggle, or a partial override. */
export type AutocutInput = boolean | Partial<AutocutConfig> | undefined;

/** Read autocut defaults from a loaded config object (DB or file plane).
 *  Out-of-range values are IGNORED (left unset) so they fall through to the
 *  mode bundle / module default — mirrors loadOverridesFromConfig. */
export function autocutFromConfig(
  cfg: Record<string, unknown> | null | undefined,
): Partial<AutocutConfig> {
  const search = (cfg?.search ?? {}) as Record<string, unknown>;
  const out: Partial<AutocutConfig> = {};
  if (typeof search.autocut === 'boolean') out.enabled = search.autocut;
  if (search.autocut_jump !== undefined) {
    const n = typeof search.autocut_jump === 'number' ? search.autocut_jump : Number.NaN;
    if (Number.isFinite(n) && n > 0 && n <= 1) out.jumpRatio = n;
  }
  if (search.autocut_min_keep !== undefined) {
    const n =
      typeof search.autocut_min_keep === 'number' ? Math.floor(search.autocut_min_keep) : Number.NaN;
    if (Number.isFinite(n) && n >= 1) out.minKeep = n;
  }
  return out;
}

/** Merge defaults → config-plane → per-call into a concrete config. */
export function resolveAutocut(
  perCall: AutocutInput,
  fromConfig?: Partial<AutocutConfig>,
): AutocutConfig {
  const base: AutocutConfig = { ...DEFAULT_AUTOCUT, ...(fromConfig ?? {}) };
  if (perCall === undefined) return base;
  if (perCall === true) return { ...base, enabled: true };
  if (perCall === false) return { ...base, enabled: false };
  return {
    ...base,
    ...perCall,
    enabled: perCall.enabled ?? base.enabled,
  };
}

function noOp<T>(results: T[]): { kept: T[]; decision: AutocutDecision } {
  return {
    kept: results,
    decision: {
      applied: false,
      signal: 'none',
      cut: results.length,
      kept: results.length,
      total: results.length,
      gapRatio: 0,
    },
  };
}

/**
 * Trim a ranked result list at the largest score discontinuity.
 *
 * `scoreOf(r)` must return the cross-encoder rerank score (or undefined/non-finite
 * for un-scored items). The function is robust to un-sorted provider output: it
 * finds the cliff on a sorted copy of the finite scores and keeps every item at or
 * above the cut threshold, preserving the input's original order. Never returns
 * empty when `results` is non-empty (at-least-minKeep failsafe).
 *
 * Behavior:
 *   - cfg.enabled false                  → no-op (signal 'none')
 *   - <2 items with a finite score       → no-op (no cliff to find; recall preserved)
 *   - top score <= 0 or non-finite       → no-op (score scale unusable)
 *   - largest normalized gap < jumpRatio  → no-op (no real cliff)
 *   - otherwise                          → keep items scored >= the cut threshold,
 *                                          dropping the lower-scored remainder AND
 *                                          any un-scored items (they carry no
 *                                          confidence signal)
 */
export function applyAutocut<T>(
  results: T[],
  scoreOf: (r: T) => number | undefined | null,
  cfg: AutocutConfig,
  /**
   * Optional always-keep predicate. Items where `preserve(r)` is true survive
   * the cut regardless of score (and are NOT required to carry a finite score).
   * Used to protect structurally-injected high-confidence results that bypass
   * reranking — e.g. an exact alias-hop match (`alias_hit === true`) inserted
   * after the reranker ran, which therefore has no `rerank_score`. Without this,
   * autocut would drop the alias-injected page when it cuts on the scored set.
   */
  preserve?: (r: T) => boolean,
): { kept: T[]; decision: AutocutDecision } {
  if (!cfg.enabled || results.length < 2) return noOp(results);

  // Collect finite scores. Under D4 (rerank the full candidate set) every item is
  // scored; we still filter defensively so a fail-open reranker (RRF order, no
  // scores) or a partial head degrades to a clean no-op.
  const scores: number[] = [];
  for (const r of results) {
    const s = scoreOf(r);
    if (typeof s === 'number' && Number.isFinite(s)) scores.push(s);
  }
  if (scores.length < 2) return noOp(results);

  const top = Math.max(...scores);
  if (!Number.isFinite(top) || top <= 0) return noOp(results);

  // Sort a copy descending (A2: don't trust upstream order) and normalize.
  const sorted = [...scores].sort((a, b) => b - a);
  const norm = sorted.map((s) => s / top);

  const minKeep = Math.max(1, cfg.minKeep);
  // Find the largest consecutive gap. Only consider cut points at or after
  // minKeep (so the failsafe is never violated) and before the last element.
  let bestGap = -1;
  let bestIdx = -1; // cut AFTER sorted[bestIdx] → keep bestIdx+1 items
  for (let i = minKeep - 1; i < norm.length - 1; i++) {
    const gap = norm[i] - norm[i + 1];
    if (gap > bestGap) {
      bestGap = gap;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestGap < cfg.jumpRatio) {
    // No cliff clears the threshold. Report the observed gap for telemetry.
    return {
      kept: results,
      decision: {
        applied: false,
        signal: 'none',
        cut: results.length,
        kept: results.length,
        total: results.length,
        gapRatio: bestGap < 0 ? 0 : bestGap,
      },
    };
  }

  // Cut threshold = the score at the cut boundary. Keep every item scored at or
  // above it (ties at the boundary stay together — conservative, never-empty),
  // PLUS any item the caller marked preserve (alias-injected exact matches that
  // bypassed reranking and carry no score).
  const threshold = sorted[bestIdx];
  const kept = results.filter((r) => {
    if (preserve?.(r)) return true;
    const s = scoreOf(r);
    return typeof s === 'number' && Number.isFinite(s) && s >= threshold;
  });

  // Failsafe: a degenerate threshold could in theory keep 0 (it cannot here, since
  // the top item always passes), but guard anyway.
  if (kept.length === 0) return noOp(results);

  return {
    kept,
    decision: {
      applied: kept.length < results.length,
      signal: kept.length < results.length ? 'rerank' : 'none',
      cut: kept.length,
      kept: kept.length,
      total: results.length,
      gapRatio: bestGap,
    },
  };
}
