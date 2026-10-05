// src/core/onboard/impact-capture.ts
// sourcescope:file-brain-wide — captureMetric reports brain-wide
// aggregates (orphan_count, stale_count, coverage fractions) by design.
// Per A26 lint opt-out.
//
// v0.41.18.0 (A6 + A25 + A17, T11). Capture before/after stats per
// remediation job step so `gbrain onboard --history` can show "you reduced
// orphans 47% (88% → 41%)". runRemediation (doctor --remediate, onboard
// --auto, MCP run_onboard) calls startStepImpact before it submits a step's
// job and finishes it once the job is terminal.
//
// Each metric reads the predicate the brain already reports it with (the
// embed worker's stale count, get_health's orphan count, the onboard
// coverage checks' entity population), so a history row agrees with
// `gbrain onboard --check` and `gbrain doctor`.
//
// Best-effort per A17: a stat-query throw must NOT block the remediation.
// Failures log to stderr and record metric_before/after = null.
//
// Attribution columns per A25 + codex finding #10: every row carries
// job_id (FK to minion_jobs), source_id, started_at, idempotency_key so
// concurrent onboard/autopilot/manual runs can't misattribute deltas to the
// wrong remediation.

import type { BrainEngine } from './../engine.ts';
import type { RemediationStep } from '../remediation-step.ts';
import { VISIBLE_ENTITY_PREDICATE } from './checks.ts';

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

/** The metric each remediation job moves. A step whose job is not listed writes no row. */
const JOB_METRICS: Readonly<Record<string, MetricName>> = {
  embed: 'stale_count',
  'embed-catch-up': 'stale_count',
  extract: 'orphan_count',
  'extract-ner': 'entity_link_coverage',
  'extract-timeline-from-meetings': 'timeline_coverage',
  'extract-takes-from-pages': 'takes_count',
};

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
      case 'stale_count':
        return await engine.countStaleChunks();
      case 'orphan_count':
        return (await engine.getHealth()).orphan_pages;
      case 'entity_link_coverage':
      case 'timeline_coverage': {
        // Exact (unsampled) fraction of visible entity pages with the feature.
        const feature = metric === 'entity_link_coverage'
          ? 'SELECT 1 FROM links l WHERE l.to_page_id = p.id'
          : 'SELECT 1 FROM timeline_entries t WHERE t.page_id = p.id';
        const [row] = await engine.executeRaw<{ total: number; matched: number }>(
          `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE EXISTS (${feature}))::int AS matched
             FROM pages p
            WHERE ${VISIBLE_ENTITY_PREDICATE}`,
        );
        const total = Number(row?.total ?? 0);
        if (total === 0) return 1; // vacuous truth — empty brain has full coverage
        return Number(row?.matched ?? 0) / total;
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
 * Capture a remediation step's metric before its job is submitted. Returns
 * the finisher that captures it again once the job is terminal and writes
 * the row, or null when the step's job moves no tracked metric.
 *
 * Per A17: capture failures DO NOT block the step. A null before/after is
 * recorded; the row still lands so downstream consumers see a "ran but
 * impact unknown" entry.
 */
export async function startStepImpact(
  engine: BrainEngine,
  step: Pick<RemediationStep, 'id' | 'job' | 'idempotency_key' | 'params'>,
): Promise<((jobId: number, details: Record<string, unknown>) => Promise<void>) | null> {
  const metric = JOB_METRICS[step.job];
  if (!metric) return null;
  const startedAt = new Date().toISOString();
  const before = await captureMetric(engine, metric);
  return async (jobId, details) => {
    const after = await captureMetric(engine, metric);
    const sourceId = step.params.sourceId;
    await writeImpactLogRow(
      engine,
      {
        remediation_id: step.id,
        job_id: jobId,
        started_at: startedAt,
        idempotency_key: step.idempotency_key,
        ...(typeof sourceId === 'string' ? { source_id: sourceId } : {}),
      },
      metric,
      before,
      after,
      { job: step.job, ...details },
    );
  };
}
