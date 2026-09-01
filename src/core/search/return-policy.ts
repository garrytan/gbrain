/**
 * return-policy.ts — intent-aware adaptive return-sizing (v0.42).
 *
 * Opt-in retrieval feature: instead of returning the full top-K candidate
 * list (noisy), return a tight set sized by query intent. Single-answer-ish
 * queries (`entity`) get a small cap; enumeration-ish queries
 * (`temporal`/`event`/`general`) get a larger cap. An at-least-`minKeep`
 * failsafe guarantees a human never gets a silent blank when candidates exist.
 *
 * WHY intent-driven caps and NOT a score-cliff detector: the PrecisionMemBench
 * Phase-1 instrumentation (gbrain-evals) measured that the rank1→rank2 score
 * gap is ~identical whether rank-1 is correct (0.602) or wrong (0.569) — RRF's
 * mechanical decay, not a trustworthy separatrix. The right belief is rank-1 in
 * 94% of single-answer cases, so "return a tight set" is the whole win;
 * cliff-cutting just adds noise. So the mechanism is a cap, with intent as the
 * (admittedly coarse) prior on how many answers the query wants.
 *
 * Default OFF. Cache-safe via the KNOBS_HASH v=27 fold (2026-08 fix wave,
 * E5b): the gate params (ar/arem/arom/armk) AND the query's resolved intent
 * class (ari) key the semantic cache, so adaptive-on calls CACHE — a trimmed
 * set can never be served to a gate-off or different-cap/intent lookup. The
 * pre-v27 mechanism (wholesale skipCache when enabled) is gone.
 *
 * Pure + dependency-light so it unit-tests in isolation.
 */

/**
 * 2026-08 fix wave (E5c): now the FULL QueryIntent union — 'concept' joined
 * so hybrid.ts no longer coerces it to 'general'. Cap mapping is unchanged in
 * effect ('entity' → entityMax, everything else → otherMax): concept queries
 * are exactly the ones that want breadth.
 */
export type AdaptiveQueryIntent = 'entity' | 'temporal' | 'event' | 'concept' | 'general';

export interface AdaptiveReturnConfig {
  /** Master switch. Default false — no behavior change for existing callers. */
  enabled: boolean;
  /** Cap for single-answer-ish (`entity`) intent. */
  entityMax: number;
  /** Cap for `temporal` / `event` / `general` intent (recall-preserving). */
  otherMax: number;
  /** Failsafe: never return fewer than this when candidates exist (≥1). */
  minKeep: number;
}

/**
 * Recall-preserving defaults (the product posture, not benchmark-maxing).
 * entity=2 keeps the dominant answer + one hedge; other=6 trims the long noisy
 * tail while keeping enumeration recall high. Precision-sensitive agents tune
 * these down (entity=1, other=1 ≈ "return only the top result").
 */
export const DEFAULT_ADAPTIVE_RETURN: AdaptiveReturnConfig = Object.freeze({
  enabled: false,
  entityMax: 2,
  otherMax: 6,
  minKeep: 1,
});

export interface AdaptiveReturnDecision {
  applied: boolean;
  intent: AdaptiveQueryIntent;
  cap: number;
  kept: number;
  total: number;
}

/** Per-call SearchOpts shape: `true`/`false` toggles, or a partial override. */
export type AdaptiveReturnInput = boolean | Partial<AdaptiveReturnConfig> | undefined;

function clampInt(v: unknown, fallback: number, min: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : Number.NaN;
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Read adaptive-return defaults from a loaded config object (DB or file plane). */
export function adaptiveReturnFromConfig(
  cfg: Record<string, unknown> | null | undefined,
): Partial<AdaptiveReturnConfig> {
  const search = (cfg?.search ?? {}) as Record<string, unknown>;
  const out: Partial<AdaptiveReturnConfig> = {};
  if (typeof search.adaptive_return === 'boolean') out.enabled = search.adaptive_return;
  if (search.adaptive_return_entity_max !== undefined)
    out.entityMax = clampInt(search.adaptive_return_entity_max, DEFAULT_ADAPTIVE_RETURN.entityMax, 1);
  if (search.adaptive_return_other_max !== undefined)
    out.otherMax = clampInt(search.adaptive_return_other_max, DEFAULT_ADAPTIVE_RETURN.otherMax, 1);
  if (search.adaptive_return_min_keep !== undefined)
    out.minKeep = clampInt(search.adaptive_return_min_keep, DEFAULT_ADAPTIVE_RETURN.minKeep, 1);
  return out;
}

/** Merge defaults → config-plane → per-call into a concrete config. */
export function resolveAdaptiveReturn(
  perCall: AdaptiveReturnInput,
  fromConfig?: Partial<AdaptiveReturnConfig>,
): AdaptiveReturnConfig {
  const base: AdaptiveReturnConfig = { ...DEFAULT_ADAPTIVE_RETURN, ...(fromConfig ?? {}) };
  if (perCall === undefined) return base;
  if (perCall === true) return { ...base, enabled: true };
  if (perCall === false) return { ...base, enabled: false };
  return {
    ...base,
    ...perCall,
    enabled: perCall.enabled ?? base.enabled,
  };
}

/**
 * True iff the gate is on (per-call or config). Convenience over
 * resolveAdaptiveReturn(...).enabled. NOTE (2026-08 wave): its former
 * production caller — hybridSearchCached's adaptive cache SKIP — is gone
 * (adaptive-on calls now cache via the KNOBS_HASH v=27 fold); kept as a
 * public helper for external callers and the unit suite.
 */
export function adaptiveReturnEnabled(
  perCall: AdaptiveReturnInput,
  cfg: Record<string, unknown> | null | undefined,
): boolean {
  return resolveAdaptiveReturn(perCall, adaptiveReturnFromConfig(cfg)).enabled;
}

/**
 * Trim a ranked result list to the intent-driven cap. Input MUST already be in
 * final ranked order. Returns the kept prefix + a decision record. Never
 * returns empty when `results` is non-empty (at-least-minKeep failsafe).
 */
export function applyAdaptiveReturn<T>(
  results: T[],
  intent: AdaptiveQueryIntent,
  cfg: AdaptiveReturnConfig,
): { kept: T[]; decision: AdaptiveReturnDecision } {
  if (!cfg.enabled || results.length === 0) {
    return {
      kept: results,
      decision: { applied: false, intent, cap: results.length, kept: results.length, total: results.length },
    };
  }
  const cap = intent === 'entity' ? cfg.entityMax : cfg.otherMax;
  const minKeep = Math.max(1, cfg.minKeep);
  const keep = Math.max(minKeep, Math.min(cap, results.length));
  const kept = results.slice(0, keep);
  return {
    kept,
    decision: { applied: true, intent, cap, kept: kept.length, total: results.length },
  };
}
