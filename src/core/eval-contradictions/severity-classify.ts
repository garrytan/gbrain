/**
 * eval-contradictions/severity-classify — M4 severity helpers.
 *
 * The judge prompt asks the LLM to assign severity (low | medium | high).
 * This module:
 *   - Validates the judge's claimed severity against an enum (defaults to 'low'
 *     on garbage input rather than throwing).
 *   - Buckets findings by severity for doctor-style output sort.
 *   - Computes per-page max_severity for the hot_pages roll-up.
 *
 * The rubric lives in the judge prompt itself (low = naming/format,
 * medium = value/state, high = identity/structural). This module is pure
 * post-processing; it does NOT re-classify or override the LLM's call.
 */

import type { ContradictionFinding, HotPage, Severity } from './types.ts';

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

/** Validate a severity string; default to 'low' on unknown input. */
export function parseSeverity(value: unknown): Severity {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return 'low';
}

/** Compare for descending sort: high > medium > low. */
export function compareSeverityDesc(a: Severity, b: Severity): number {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a];
}

/** Return findings grouped by severity. Order within each group preserved from input. */
export function bucketBySeverity(
  findings: readonly ContradictionFinding[],
): Record<Severity, ContradictionFinding[]> {
  const out: Record<Severity, ContradictionFinding[]> = { low: [], medium: [], high: [] };
  for (const f of findings) {
    out[f.severity].push(f);
  }
  return out;
}

/**
 * Roll up appearances across all findings into per-page totals + max severity.
 * Sorted by appearances DESC, then max_severity DESC for stable ties.
 */
export function buildHotPages(
  findings: readonly ContradictionFinding[],
  limit = 10,
): HotPage[] {
  const acc = new Map<string, { count: number; maxSev: Severity }>();
  const touch = (slug: string, sev: Severity) => {
    const prior = acc.get(slug);
    if (!prior) {
      acc.set(slug, { count: 1, maxSev: sev });
      return;
    }
    prior.count++;
    if (SEVERITY_RANK[sev] > SEVERITY_RANK[prior.maxSev]) {
      prior.maxSev = sev;
    }
  };
  for (const f of findings) {
    touch(f.a.slug, f.severity);
    if (f.b.slug !== f.a.slug) touch(f.b.slug, f.severity);
  }
  const rows: HotPage[] = Array.from(acc.entries()).map(([slug, v]) => ({
    slug,
    appearances: v.count,
    max_severity: v.maxSev,
  }));
  rows.sort(
    (x, y) => y.appearances - x.appearances || SEVERITY_RANK[y.max_severity] - SEVERITY_RANK[x.max_severity],
  );
  return rows.slice(0, limit);
}
