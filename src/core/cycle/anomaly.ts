/**
 * v0.29 — Anomaly detection: statistical helpers for the `find_anomalies` op.
 *
 * Pure functions over densified daily-count buckets. The engine layer runs the
 * SQL (CTE-shaped, with `generate_series` zero-fill so rare cohorts don't get
 * sparse-day biased baselines per codex C4#6) and hands the results here. This
 * keeps `findAnomalies` mostly testable without a database.
 *
 * Cohort kinds: tag, type. Year cohort is deferred to v0.30 pending proper
 * frontmatter date-field detection.
 */

import type { AnomalyResult } from '../types.ts';

/** One row of the densified daily-count series for a single cohort key. */
export interface CohortDayRow {
  cohort_kind: 'tag' | 'type';
  cohort_value: string;
  /** ISO date (YYYY-MM-DD). */
  day: string;
  /** Distinct pages touched in this cohort on `day`. Zero if no activity. */
  count: number;
}

/** "Today" current-window count per cohort plus the page slugs that drove it. */
export interface CohortTodayRow {
  cohort_kind: 'tag' | 'type';
  cohort_value: string;
  count: number;
  page_slugs: string[];
}

/**
 * Mean and (sample) stddev of a number array. Returns `(0, 0)` for empty
 * input. Uses the sample stddev (n-1 denominator) so a single-sample baseline
 * doesn't claim zero variance.
 */
export function meanStddev(samples: number[]): { mean: number; stddev: number } {
  if (samples.length === 0) return { mean: 0, stddev: 0 };
  const sum = samples.reduce((a, b) => a + b, 0);
  const mean = sum / samples.length;
  if (samples.length === 1) return { mean, stddev: 0 };
  const sqSum = samples.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const variance = sqSum / (samples.length - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Compute anomaly results from densified baseline buckets + today's counts.
 *
 * For each cohort:
 *   1. Compute (mean, stddev) over the baseline daily counts.
 *   2. If stddev > 0:    anomalous when `today.count > mean + sigma*stddev`.
 *      sigma_observed   = (today.count - mean) / stddev.
 *   3. If stddev == 0:   small-sample fallback — anomalous when
 *      `today.count > mean + 1`. sigma_observed treated as a finite proxy
 *      `today.count - mean` so callers still get a usable sort key.
 *
 * Cohorts with no baseline rows AND no today rows are skipped. Cohorts
 * appearing only in `today` (a brand-new cohort) get a baseline_mean of 0
 * — they're surfaced as anomalies whenever today.count >= 2 (mean+1 fallback).
 *
 * Returns top `limit` rows sorted by `sigma_observed` descending. Each row
 * caps `page_slugs` at 50 entries.
 *
 * @param baseline densified rows over the lookback window, grouped by cohort × day.
 * @param today    rows for the target day, grouped by cohort.
 * @param sigma    threshold multiplier (default 3.0).
 * @param limit    max anomalies to return (default 20).
 */
export function computeAnomaliesFromBuckets(
  baseline: CohortDayRow[],
  today: CohortTodayRow[],
  sigma: number,
  limit: number = 20,
): AnomalyResult[] {
  // Group baseline samples by (cohort_kind, cohort_value).
  const baselineByCohort = new Map<string, number[]>();
  for (const row of baseline) {
    const key = cohortKey(row.cohort_kind, row.cohort_value);
    const list = baselineByCohort.get(key);
    if (list) {
      list.push(row.count);
    } else {
      baselineByCohort.set(key, [row.count]);
    }
  }

  const out: AnomalyResult[] = [];
  for (const t of today) {
    const key = cohortKey(t.cohort_kind, t.cohort_value);
    const samples = baselineByCohort.get(key) ?? [];
    const { mean, stddev } = meanStddev(samples);

    let isAnomaly: boolean;
    let sigmaObserved: number;
    if (stddev > 0) {
      const threshold = mean + sigma * stddev;
      isAnomaly = t.count > threshold;
      sigmaObserved = (t.count - mean) / stddev;
    } else {
      // Zero-stddev fallback (or empty baseline). Sigma is undefined; we use
      // (count - mean) as a finite sort proxy and require count > mean + 1
      // to avoid surfacing every 1-page-touched cohort as anomalous.
      isAnomaly = t.count > mean + 1;
      sigmaObserved = t.count - mean;
    }

    if (!isAnomaly) continue;
    out.push({
      cohort_kind: t.cohort_kind,
      cohort_value: t.cohort_value,
      count: t.count,
      baseline_mean: mean,
      baseline_stddev: stddev,
      sigma_observed: sigmaObserved,
      page_slugs: t.page_slugs.slice(0, 50),
    });
  }

  out.sort((a, b) => b.sigma_observed - a.sigma_observed);
  return out.slice(0, limit);
}

function cohortKey(kind: string, value: string): string {
  // \x1f (unit separator) — a byte that can't appear in tags or PageType values.
  return `${kind}\x1f${value}`;
}
