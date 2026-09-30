/** Salience / recency resolution shared by hybridSearch and the hybridSearchCached key. */
import type { HybridSearchOpts } from '../hybrid.ts';
import type { QuerySuggestions } from '../query-intent.ts';
import { weightsForIntent } from '../intent-weights.ts';

/**
 * wave-g (#4415 knobs-hash fold) — the ONE salience resolution chain, shared
 * by bare hybridSearch (post-fusion boost) and hybridSearchCached (the
 * `sal=` cache-key part). Explicit per-call opt wins; otherwise the
 * classifier's pattern-aware suggestion.
 */
export function resolveEffectiveSalience(
  opts: HybridSearchOpts | undefined,
  suggestions: QuerySuggestions,
): 'off' | 'on' | 'strong' {
  return opts?.salience ?? suggestions.suggestedSalience;
}

/**
 * wave-g (#4415 knobs-hash fold) — the ONE recency resolution chain, shared
 * by bare hybridSearch and hybridSearchCached (the `rec=` cache-key part).
 *
 * Back-compat: recencyBoost: 1|2 → 'on'|'strong'; 0 → 'off'.
 * Intent-weighting recency suggestion is a NUDGE — it only fires when the
 * caller left recency unspecified AND the classifier's own suggestedRecency
 * (v0.29.1) didn't fire; it stays null when intent weighting is off.
 */
export function resolveEffectiveRecency(
  opts: HybridSearchOpts | undefined,
  suggestions: QuerySuggestions,
  intentWeightingOn: boolean,
): 'off' | 'on' | 'strong' {
  const legacyRecency: 'off' | 'on' | 'strong' | undefined =
    opts?.recencyBoost === 2 ? 'strong' :
    opts?.recencyBoost === 1 ? 'on' :
    opts?.recencyBoost === 0 ? 'off' :
    undefined;
  const intentRecency = intentWeightingOn
    ? (weightsForIntent(suggestions.intent).suggestedRecency ?? null)
    : null;
  return (
    opts?.recency
    ?? legacyRecency
    ?? (suggestions.suggestedRecency !== 'off'
        ? suggestions.suggestedRecency
        : (intentRecency ?? suggestions.suggestedRecency))
  );
}
