/**
 * v0.36.1.0 (T10 / E5) — Brier-trend forecasting on new takes.
 *
 * Pure math over existing `TakesScorecard` data. Zero new LLM cost,
 * zero new schema. Surface: an inline blurb the user sees at write time
 * (gbrain takes show / propose --review) reminding them of their
 * historical track record at this conviction + domain.
 *
 * v0.36.1.0 ship state:
 *   Looks up scorecard by (holder, domainPrefix). The bucket dimension is
 *   the domain — not the conviction-weight bucket (full conviction-bucket
 *   math would need a new engine method). Returns "insufficient data"
 *   when n < 5 (avoid noise on cold brains).
 *
 * v0.37+ enhancement:
 *   Add conviction-bucket dimension via engine.batchGetTakeBucketStats()
 *   (per F11). For now the forecast is per-domain only.
 *
 * Output goes through the voice gate's forecast_blurb template when
 * surfaced to the user (E5 inline rendering). This module is the pure
 * data layer; templates.ts has the user-facing string.
 */

import type { BrainEngine, TakesScorecard } from '../engine.ts';

export interface TakeForecastInput {
  /** Take's holder, e.g. 'garry' or 'people/charlie-example'. */
  holder: string;
  /**
   * Optional domain prefix, e.g. 'macro' or 'geography'. When omitted, the
   * forecast uses the holder's overall scorecard.
   */
  domain?: string;
  /** The conviction-weight of the new take in [0,1]. Carried into the response. */
  conviction: number;
}

export interface TakeForecast {
  /**
   * Predicted Brier score for this conviction in this domain. Null when
   * the bucket has insufficient data (n < MIN_BUCKET_N).
   */
  predicted_brier: number | null;
  /** Sample size of the bucket. */
  bucket_n: number;
  /** Holder's overall Brier for comparison ("worse than your average"). */
  overall_brier: number | null;
  /** The domain the forecast bucket scoped to ('overall' when no domain). */
  bucket_domain: string;
  /** True when the bucket lacks enough data for a stable forecast. */
  insufficient_data: boolean;
}

/** Minimum bucket size before we report a forecast. Below this → null. */
export const MIN_BUCKET_N = 5;

/**
 * Map a free-form domain hint (e.g. 'macro tech', 'geography', or
 * 'startup-tactics') to a `domainPrefix` the scorecard query understands.
 *
 * The TakesScorecard's `domainPrefix` is a slug-prefix filter (e.g.
 * 'companies/'). For v0.36.1.0, we pass domain hints through as-is when
 * they look like slug prefixes; otherwise fall back to undefined (overall
 * scorecard). v0.37+ takes get a structured domain enum and this mapping
 * tightens.
 */
export function resolveDomainPrefix(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  const lower = domain.toLowerCase().trim();
  if (lower.length === 0) return undefined;
  // Slug-prefix-looking values: keep as-is.
  if (lower.endsWith('/')) return lower;
  if (lower.startsWith('wiki/') || lower.startsWith('companies/') || lower.startsWith('people/')) {
    return lower;
  }
  // Free-form word (e.g. 'macro tech', 'geography') — no slug prefix path,
  // so the bucket falls back to "overall" for now. v0.37+ Hindsight-style
  // structured domain on takes (CDX-11 mitigation TODO) tightens this.
  return undefined;
}

/**
 * Pure math: given the holder's overall scorecard AND optional bucketed
 * scorecard, compute the forecast struct.
 *
 * Caller is responsible for fetching the scorecards via engine.getScorecard.
 * Pure function so tests can drive it without an engine.
 */
export function computeForecast(input: {
  conviction: number;
  domain?: string;
  overallScorecard: TakesScorecard;
  bucketScorecard?: TakesScorecard;
}): TakeForecast {
  const overall_brier = input.overallScorecard.brier;
  const bucket = input.bucketScorecard ?? input.overallScorecard;
  const bucket_domain = input.domain ?? 'overall';
  const bucket_n = bucket.resolved;
  const insufficient_data = bucket_n < MIN_BUCKET_N;
  const predicted_brier = insufficient_data ? null : bucket.brier;
  return { predicted_brier, bucket_n, overall_brier, bucket_domain, insufficient_data };
}

/**
 * Wrapper that fetches the scorecards from the engine + computes the
 * forecast. Convenience for callers that don't need to share scorecard
 * data across multiple forecasts.
 */
export async function forecastForTake(
  engine: BrainEngine,
  input: TakeForecastInput,
): Promise<TakeForecast> {
  const overallScorecard = await engine.getScorecard({ holder: input.holder }, undefined);
  const domainPrefix = resolveDomainPrefix(input.domain);
  let bucketScorecard: TakesScorecard | undefined;
  if (domainPrefix) {
    bucketScorecard = await engine.getScorecard(
      { holder: input.holder, domainPrefix },
      undefined,
    );
  }
  return computeForecast({
    conviction: input.conviction,
    ...(input.domain !== undefined ? { domain: input.domain } : {}),
    overallScorecard,
    ...(bucketScorecard !== undefined ? { bucketScorecard } : {}),
  });
}

/**
 * Batched forecast over a list of takes (F11 perf finding). Returns one
 * TakeForecast per input. v0.36.1.0 ship state: per-take engine round-trip.
 * v0.37+ adds engine.batchGetTakeBucketStats for a single roundtrip across
 * all (holder, domain) pairs.
 */
export async function batchForecast(
  engine: BrainEngine,
  inputs: TakeForecastInput[],
): Promise<TakeForecast[]> {
  // Memoize per (holder, domainPrefix) so repeated queries collapse.
  const cache = new Map<string, TakesScorecard>();
  const getOrFetch = async (holder: string, domainPrefix?: string): Promise<TakesScorecard> => {
    const key = `${holder}|${domainPrefix ?? ''}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const sc = await engine.getScorecard(
      { holder, ...(domainPrefix !== undefined ? { domainPrefix } : {}) },
      undefined,
    );
    cache.set(key, sc);
    return sc;
  };
  const results: TakeForecast[] = [];
  for (const input of inputs) {
    const overallScorecard = await getOrFetch(input.holder);
    const domainPrefix = resolveDomainPrefix(input.domain);
    const bucketScorecard = domainPrefix
      ? await getOrFetch(input.holder, domainPrefix)
      : undefined;
    results.push(
      computeForecast({
        conviction: input.conviction,
        ...(input.domain !== undefined ? { domain: input.domain } : {}),
        overallScorecard,
        ...(bucketScorecard !== undefined ? { bucketScorecard } : {}),
      }),
    );
  }
  return results;
}
