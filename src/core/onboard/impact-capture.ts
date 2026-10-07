// src/core/onboard/impact-capture.ts
// sourcescope:file-brain-wide — captureMetric reports brain-wide
// aggregates (orphan_count, stale_count, coverage fractions) by design.
// Per A26 lint opt-out.
//
// v0.41.18.0 (A6 + A25 + A17, T11). Before/after stats for remediation job
// steps, the rows `gbrain onboard --history` reads ("you reduced orphans
// 47% (88% → 41%)"). runRemediation is the writer: it opens a probe before
// it submits a step's job and closes it once that job is terminal. Steps
// whose job moves no tracked metric, dry runs, and steps that throw before
// their job is terminal leave no row.
//
// Every metric is read through the brain's own definition of it, so a row
// agrees with doctor and `onboard --check`: the embed worker's stale-chunk
// count, findOrphanPages under the shared orphan-reporting policy (what
// get_health counts), and the onboard coverage checks' own query.
//
// Best-effort per A17: a stat-query or log-write failure must NOT change the
// step's outcome. Failures log to stderr; a failed capture records null.
//
// Attribution columns per A25 + codex finding #10: rows carry job_id (FK to
// minion_jobs), source_id, started_at and idempotency_key so concurrent
// onboard/autopilot/manual runs can't misattribute deltas to the wrong
// remediation.

import type { BrainEngine } from './../engine.ts';
import type { RemediationStep } from '../remediation-step.ts';
import { loadOrphanPolicyOverrides, shouldExcludeFromOrphanReporting } from '../orphan-policy.ts';
import { LINK_COVERAGE_FEATURE, TIMELINE_COVERAGE_FEATURE, visibleEntityCoverageSql } from './checks.ts';

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
 * The tracked metric a remediation job is expected to move, or null when its
 * effect has no single metric (its steps then record no history row).
 */
export function impactMetricForJob(job: string): MetricName | null {
  switch (job) {
    case 'embed':
    case 'embed-catch-up':
      return 'stale_count';
    case 'extract':
      return 'orphan_count';
    case 'extract-ner':
      return 'entity_link_coverage';
    case 'extract-timeline-from-meetings':
      return 'timeline_coverage';
    case 'extract-takes-from-pages':
      return 'takes_count';
    default:
      return null;
  }
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
      case 'stale_count':
        return await engine.countStaleChunks();
      case 'orphan_count': {
        const [candidates, overrides] = await Promise.all([
          engine.findOrphanPages(),
          loadOrphanPolicyOverrides(engine),
        ]);
        return candidates.filter((page) => !shouldExcludeFromOrphanReporting(page.slug, overrides, page)).length;
      }
      case 'entity_link_coverage':
      case 'timeline_coverage': {
        const feature = metric === 'entity_link_coverage' ? LINK_COVERAGE_FEATURE : TIMELINE_COVERAGE_FEATURE;
        const [row] = await engine.executeRaw<{ sample_size: number; matched: number }>(visibleEntityCoverageSql(feature));
        const population = Number(row?.sample_size ?? 0);
        // An empty population is vacuously covered.
        return population === 0 ? 1 : Number(row?.matched ?? 0) / population;
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

/** A step's metric as read just before its job was submitted. */
export interface StepImpactProbe {
  metric: MetricName;
  before: number | null;
  startedAt: string;
}

type ImpactStep = Pick<RemediationStep, 'id' | 'job' | 'idempotency_key' | 'params'>;

/**
 * Read the metric `step`'s job moves, before the job is submitted. Returns
 * null (and reads nothing) when the job has no tracked metric.
 */
export async function openStepImpact(engine: BrainEngine, step: ImpactStep): Promise<StepImpactProbe | null> {
  const metric = impactMetricForJob(step.job);
  if (metric === null) return null;
  const startedAt = new Date().toISOString();
  return { metric, startedAt, before: await captureMetric(engine, metric) };
}

/**
 * Read the metric again now that the step's job is terminal and write the
 * step's history row. Never throws: a failed read records null and a failed
 * write only logs (A17).
 */
export async function closeStepImpact(
  engine: BrainEngine,
  probe: StepImpactProbe,
  step: ImpactStep,
  outcome: { jobId: number; status: string; doctorRunId: string },
): Promise<void> {
  const after = await captureMetric(engine, probe.metric);
  const sourceId = typeof step.params.sourceId === 'string' ? step.params.sourceId : undefined;
  await writeImpactLogRow(
    engine,
    {
      remediation_id: step.id,
      job_id: outcome.jobId,
      started_at: probe.startedAt,
      idempotency_key: step.idempotency_key,
      source_id: sourceId,
    },
    probe.metric,
    probe.before,
    after,
    { job: step.job, status: outcome.status, doctor_run_id: outcome.doctorRunId },
  );
}
