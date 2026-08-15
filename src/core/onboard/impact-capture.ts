// src/core/onboard/impact-capture.ts
// sourcescope:file-brain-wide — captureMetric reports brain-wide
// aggregates (orphan_count, stale_count, coverage fractions) by design.
// Per A26 lint opt-out.
//
// v0.41.18.0 (A6 + A25 + A17, T11). Capture before/after stats per onboard
// remediation step so `gbrain onboard --history` can show "you reduced
// orphans 47% (88% → 41%)".
//
// Best-effort per A17: a stat-query throw must NOT block the extraction
// itself. The wrapper logs failures to stderr and records
// metric_before/after = null when the capture failed.
//
// Attribution columns per A25 + codex finding #10: every row carries
// job_id (FK to minion_jobs), source_id, brain_id, started_at,
// idempotency_key so concurrent onboard/autopilot/manual runs can't
// misattribute deltas to the wrong remediation.

import type { BrainEngine } from './../engine.ts';

export type MetricName =
  | 'orphan_count'
  | 'stale_count'
  | 'entity_link_coverage'
  | 'timeline_coverage'
  | 'takes_count';

export interface ImpactAttribution {
  remediation_id: string;
  job_id?: number;
  source_id?: string;
  brain_id?: string;
  started_at?: string;
  idempotency_key?: string;
  applied_by?: string;
}

/**
 * Pure-ish: returns the current numeric value for `metric`. Returns null
 * on any throw (best-effort capture per A17).
 */
export async function captureMetric(
  engine: BrainEngine,
  metric: MetricName,
): Promise<number | null> {
  try {
    switch (metric) {
      case 'stale_count': {
        const rows = await engine.executeRaw<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM content_chunks WHERE embedding IS NULL`,
        );
        return rows.length > 0 ? Number(rows[0].count) : 0;
      }
      case 'orphan_count': {
        const rows = await engine.executeRaw<{ count: string | number }>(
          `SELECT COUNT(*) AS count
             FROM pages p
            WHERE p.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)`,
        );
        return rows.length > 0 ? Number(rows[0].count) : 0;
      }
      case 'entity_link_coverage':
      case 'timeline_coverage': {
        // Compute as a fraction of entity pages with the relevant feature.
        const total = await engine.executeRaw<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM pages
             WHERE type IN ('person', 'company', 'organization', 'entity')
               AND deleted_at IS NULL`,
        );
        const totalN = total.length > 0 ? Number(total[0].count) : 0;
        if (totalN === 0) return 1; // vacuous truth — empty brain has full coverage
        if (metric === 'entity_link_coverage') {
          const withLinks = await engine.executeRaw<{ count: string | number }>(
            `SELECT COUNT(*) AS count FROM pages p
               WHERE p.type IN ('person', 'company', 'organization', 'entity')
                 AND p.deleted_at IS NULL
                 AND EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)`,
          );
          return withLinks.length > 0 ? Number(withLinks[0].count) / totalN : 0;
        }
        const withTimeline = await engine.executeRaw<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM pages p
             WHERE p.type IN ('person', 'company', 'organization', 'entity')
               AND p.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = p.id)`,
        );
        return withTimeline.length > 0 ? Number(withTimeline[0].count) / totalN : 0;
      }
      case 'takes_count': {
        const rows = await engine.executeRaw<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM takes`,
        );
        return rows.length > 0 ? Number(rows[0].count) : 0;
      }
    }
  } catch (err) {
    process.stderr.write(
      `[impact-capture] failed to capture ${metric}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

/**
 * Write one migration_impact_log row. Best-effort: a write failure logs
 * to stderr but doesn't throw.
 */
export async function writeImpactLogRow(
  engine: BrainEngine,
  attribution: ImpactAttribution,
  metricName: MetricName,
  metricBefore: number | null,
  metricAfter: number | null,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await engine.executeRaw(
      `INSERT INTO migration_impact_log (
         remediation_id, metric_name, metric_before, metric_after,
         job_id, source_id, brain_id, started_at, idempotency_key,
         applied_by, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb)`,
      [
        attribution.remediation_id,
        metricName,
        metricBefore,
        metricAfter,
        attribution.job_id ?? null,
        attribution.source_id ?? null,
        attribution.brain_id ?? null,
        attribution.started_at ?? new Date().toISOString(),
        attribution.idempotency_key ?? null,
        attribution.applied_by ?? null,
        JSON.stringify(details ?? {}),
      ],
    );
  } catch (err) {
    process.stderr.write(
      `[impact-capture] failed to write log row for ${attribution.remediation_id}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Convenience wrapper: capture-before → run → capture-after → write log.
 * The runner itself does the extraction; this fn handles the bookkeeping.
 *
 * Per A17: capture failures DO NOT block the runner. A null before/after
 * is recorded; the row still lands so downstream consumers see a
 * "ran but impact unknown" entry.
 */
export async function withImpactCapture<T>(
  engine: BrainEngine,
  attribution: ImpactAttribution,
  metric: MetricName,
  runner: () => Promise<T>,
  details?: Record<string, unknown>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  const before = await captureMetric(engine, metric);
  let result: T;
  try {
    result = await runner();
  } catch (err) {
    // Capture "after" even on failure so the log row reflects the attempt.
    const afterOnFail = await captureMetric(engine, metric);
    await writeImpactLogRow(
      engine,
      { ...attribution, started_at: startedAt },
      metric,
      before,
      afterOnFail,
      { ...(details ?? {}), error: err instanceof Error ? err.message : String(err) },
    );
    throw err;
  }
  const after = await captureMetric(engine, metric);
  await writeImpactLogRow(
    engine,
    { ...attribution, started_at: startedAt },
    metric,
    before,
    after,
    details,
  );
  return result;
}
