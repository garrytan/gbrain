#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import {
  advanceMemoryCandidateStatus,
  verifyMemoryCandidateEntry,
} from '../../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../../src/core/services/memory-inbox-promotion-service.ts';
import { recordCanonicalHandoff } from '../../src/core/services/canonical-handoff-service.ts';
import { assessHistoricalValidity } from '../../src/core/services/historical-validity-service.ts';

type Phase7HistoricalValidityWorkloadResult =
  | {
      name: 'historical_validity';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'historical_validity_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase7HistoricalValidityAcceptanceCheck {
  name:
    | 'historical_validity_p95_ms'
    | 'historical_validity_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  historical_validity_p95_ms_max: 100,
  historical_validity_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const DEFAULT_SCOPE_ID = 'workspace:default';
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase7-historical-validity.ts [--json]');
  process.exit(0);
}

const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase7-historical-validity-'));
const databasePath = join(tempDir, 'phase7-historical-validity.db');
const engine = new SQLiteEngine();

try {
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  const workloads: Phase7HistoricalValidityWorkloadResult[] = [
    await runCorrectnessWorkload(engine),
    await runLatencyWorkload(engine),
  ];

  const payload = {
    generated_at: new Date().toISOString(),
    engine: 'sqlite',
    phase: 'phase7',
    workloads,
    acceptance: evaluateAcceptance(workloads),
  };

  console.log(JSON.stringify(payload, null, 2));
} finally {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runCorrectnessWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase7HistoricalValidityWorkloadResult, { name: 'historical_validity_correctness' }>> {
  let checks = 0;
  let passes = 0;

  await seedPromotedCandidate(engine, 'phase7-valid-current', DEFAULT_SCOPE_ID, '2026-04-23T10:00:00.000Z', 'concepts/historical-validity/current');
  await recordCanonicalHandoff(engine, {
    candidate_id: 'phase7-valid-current',
    reviewed_at: '2026-04-23T10:05:00.000Z',
  });
  const current = await assessHistoricalValidity(engine, {
    candidate_id: 'phase7-valid-current',
    now: new Date('2026-04-24T00:00:00.000Z'),
  });
  checks += 1;
  if (current.decision === 'allow' && current.recommended_fallback === 'none') {
    passes += 1;
  }

  await seedPromotedCandidate(engine, 'phase7-valid-stale', DEFAULT_SCOPE_ID, '2026-02-01T10:00:00.000Z', 'concepts/historical-validity/stale');
  await recordCanonicalHandoff(engine, {
    candidate_id: 'phase7-valid-stale',
    reviewed_at: '2026-02-01T10:05:00.000Z',
  });
  const stale = await assessHistoricalValidity(engine, {
    candidate_id: 'phase7-valid-stale',
    now: new Date('2026-04-24T00:00:00.000Z'),
  });
  checks += 1;
  if (stale.decision === 'defer' && stale.stale_claim && stale.reasons.includes('candidate_review_window_expired')) {
    passes += 1;
  }

  await seedPromotedCandidate(engine, 'phase7-valid-no-handoff', DEFAULT_SCOPE_ID, '2026-04-23T10:00:00.000Z', 'concepts/historical-validity/no-handoff');
  const missingHandoff = await assessHistoricalValidity(engine, {
    candidate_id: 'phase7-valid-no-handoff',
    now: new Date('2026-04-24T00:00:00.000Z'),
  });
  checks += 1;
  if (missingHandoff.decision === 'deny' && missingHandoff.reasons.includes('candidate_missing_handoff')) {
    passes += 1;
  }

  await seedPromotedCandidate(engine, 'phase7-valid-older', DEFAULT_SCOPE_ID, '2026-04-20T10:00:00.000Z', 'concepts/historical-validity/supersede');
  await recordCanonicalHandoff(engine, {
    candidate_id: 'phase7-valid-older',
    reviewed_at: '2026-04-20T10:05:00.000Z',
  });
  await seedPromotedCandidate(engine, 'phase7-valid-newer', DEFAULT_SCOPE_ID, '2026-04-23T10:00:00.000Z', 'concepts/historical-validity/supersede');
  await recordCanonicalHandoff(engine, {
    candidate_id: 'phase7-valid-newer',
    reviewed_at: '2026-04-23T10:05:00.000Z',
  });
  const superseded = await assessHistoricalValidity(engine, {
    candidate_id: 'phase7-valid-older',
    now: new Date('2026-04-24T00:00:00.000Z'),
  });
  checks += 1;
  if (superseded.decision === 'deny' && superseded.recommended_fallback === 'supersede') {
    passes += 1;
  }

  await seedPromotedCandidate(engine, 'phase7-valid-reviewed', DEFAULT_SCOPE_ID, '2026-04-23T11:00:00.000Z', 'concepts/historical-validity/conflict');
  await recordCanonicalHandoff(engine, {
    candidate_id: 'phase7-valid-reviewed',
    reviewed_at: '2026-04-23T11:05:00.000Z',
  });
  await seedStagedCandidate(engine, 'phase7-valid-competing', DEFAULT_SCOPE_ID, 'concepts/historical-validity/conflict');
  const conflict = await assessHistoricalValidity(engine, {
    candidate_id: 'phase7-valid-reviewed',
    now: new Date('2026-04-24T00:00:00.000Z'),
  });
  checks += 1;
  if (conflict.decision === 'defer' && conflict.recommended_fallback === 'unresolved_conflict') {
    passes += 1;
  }

  return {
    name: 'historical_validity_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

async function runLatencyWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase7HistoricalValidityWorkloadResult, { name: 'historical_validity' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const id = `phase7-valid-latency-${sample}`;
    await seedPromotedCandidate(engine, id, DEFAULT_SCOPE_ID, '2026-04-23T10:00:00.000Z', `concepts/historical-validity/latency/${sample}`);
    await recordCanonicalHandoff(engine, {
      candidate_id: id,
      reviewed_at: '2026-04-23T10:05:00.000Z',
    });

    const start = performance.now();
    await assessHistoricalValidity(engine, {
      candidate_id: id,
      now: new Date('2026-04-24T00:00:00.000Z'),
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'historical_validity',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function seedPromotedCandidate(
  engine: SQLiteEngine,
  id: string,
  scopeId: string,
  reviewedAt: string,
  targetObjectId: string,
) {
  await engine.createMemoryCandidateEntry({
    id,
    scope_id: scopeId,
    candidate_type: 'fact',
    proposed_content: `Historical validity benchmark candidate ${id}.`,
    source_refs: ['User, direct message, 2026-04-24 8:40 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.9,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: targetObjectId,
    reviewed_at: null,
    review_reason: null,
  });
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, {
    id,
    next_status: 'staged_for_review',
    review_reason: 'Prepared for validity benchmark.',
  });
  await verifyMemoryCandidateEntry(engine, {
    id,
    verification_status: 'verified',
    verification_method: 'source_recheck',
    verification_evidence: `Verified historical validity benchmark fixture ${id}.`,
    verification_source_refs: [`Fixture verification for ${id}`],
    verified_at: '2026-06-16T00:00:00Z',
  });
  await promoteMemoryCandidateEntry(engine, {
    id,
    reviewed_at: reviewedAt,
    review_reason: `Promoted ${id}.`,
  });
}

async function seedStagedCandidate(
  engine: SQLiteEngine,
  id: string,
  scopeId: string,
  targetObjectId: string,
) {
  await engine.createMemoryCandidateEntry({
    id,
    scope_id: scopeId,
    candidate_type: 'fact',
    proposed_content: `Competing staged benchmark candidate ${id}.`,
    source_refs: ['User, direct message, 2026-04-24 8:45 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.6,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: targetObjectId,
    reviewed_at: null,
    review_reason: null,
  });
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, {
    id,
    next_status: 'staged_for_review',
    review_reason: 'Competing benchmark candidate.',
  });
}

function evaluateAcceptance(workloads: Phase7HistoricalValidityWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'historical_validity');
  const correctness = workloads.find((workload) => workload.name === 'historical_validity_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing historical validity benchmark workloads');
  }

  const checks: Phase7HistoricalValidityAcceptanceCheck[] = [
    {
      name: 'historical_validity_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.historical_validity_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: { operator: '<=', value: THRESHOLDS.historical_validity_p95_ms_max, unit: 'ms' },
    },
    {
      name: 'historical_validity_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.historical_validity_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: { operator: '===', value: THRESHOLDS.historical_validity_correctness_success_rate, unit: 'percent' },
    },
  ];

  const allPass = checks.every((check) => check.status === 'pass');
  return {
    readiness_status: allPass ? 'pass' : 'fail',
    phase7_status: allPass ? 'pass' : 'fail',
    checks,
  };
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function formatMeasuredMs(value: number): number {
  return Number(value.toFixed(3));
}

function formatPercent(value: number): number {
  return Number(value.toFixed(2));
}
