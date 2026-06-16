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

type Phase7CanonicalHandoffWorkloadResult =
  | {
      name: 'canonical_handoff';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'canonical_handoff_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase7CanonicalHandoffAcceptanceCheck {
  name:
    | 'canonical_handoff_p95_ms'
    | 'canonical_handoff_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  canonical_handoff_p95_ms_max: 100,
  canonical_handoff_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const DEFAULT_SCOPE_ID = 'workspace:default';
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase7-canonical-handoff.ts [--json]');
  process.exit(0);
}

const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase7-canonical-handoff-'));
const databasePath = join(tempDir, 'phase7-canonical-handoff.db');
const engine = new SQLiteEngine();

try {
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  const workloads: Phase7CanonicalHandoffWorkloadResult[] = [
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
): Promise<Extract<Phase7CanonicalHandoffWorkloadResult, { name: 'canonical_handoff_correctness' }>> {
  let checks = 0;
  let passes = 0;

  await seedPromotedCandidate(engine, 'phase7-handoff-correctness');
  const candidateBefore = await engine.getMemoryCandidateEntry('phase7-handoff-correctness');
  const recorded = await recordCanonicalHandoff(engine, {
    candidate_id: 'phase7-handoff-correctness',
    review_reason: 'Ready for canonical note update.',
  });

  checks += 1;
  if (
    recorded.handoff.target_object_type === 'curated_note'
    && recorded.handoff.target_object_id === 'concepts/canonical-handoff'
    && recorded.handoff.source_refs.length === 1
  ) {
    passes += 1;
  }

  const candidateAfter = await engine.getMemoryCandidateEntry('phase7-handoff-correctness');
  checks += 1;
  if (candidateAfter?.status === 'promoted' && candidateAfter?.review_reason === candidateBefore?.review_reason) {
    passes += 1;
  }

  const listed = await engine.listCanonicalHandoffEntries({
    scope_id: DEFAULT_SCOPE_ID,
    limit: 10,
    offset: 0,
  });
  checks += 1;
  if (listed.some((entry) => entry.candidate_id === 'phase7-handoff-correctness')) {
    passes += 1;
  }

  return {
    name: 'canonical_handoff_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

async function runLatencyWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase7CanonicalHandoffWorkloadResult, { name: 'canonical_handoff' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const id = `phase7-handoff-latency-${sample}`;
    await seedPromotedCandidate(engine, id);

    const start = performance.now();
    await recordCanonicalHandoff(engine, {
      candidate_id: id,
      review_reason: 'Recorded explicit handoff.',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'canonical_handoff',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function seedPromotedCandidate(engine: SQLiteEngine, id: string) {
  await engine.createMemoryCandidateEntry({
    id,
    scope_id: DEFAULT_SCOPE_ID,
    candidate_type: 'fact',
    proposed_content: `Canonical handoff benchmark candidate ${id}.`,
    source_refs: ['User, direct message, 2026-04-23 11:45 PM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.9,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/canonical-handoff',
    reviewed_at: null,
    review_reason: null,
  });
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, {
    id,
    next_status: 'staged_for_review',
    review_reason: 'Prepared for handoff review.',
  });
  await verifyMemoryCandidateEntry(engine, {
    id,
    verification_status: 'verified',
    verification_method: 'source_recheck',
    verification_evidence: `Verified canonical handoff benchmark fixture ${id}.`,
    verification_source_refs: [`Fixture verification for ${id}`],
    verified_at: '2026-06-16T00:00:00Z',
  });
  await promoteMemoryCandidateEntry(engine, {
    id,
    review_reason: 'Promoted before explicit handoff.',
  });
}

function evaluateAcceptance(workloads: Phase7CanonicalHandoffWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'canonical_handoff');
  const correctness = workloads.find((workload) => workload.name === 'canonical_handoff_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing canonical handoff benchmark workloads');
  }

  const checks: Phase7CanonicalHandoffAcceptanceCheck[] = [
    {
      name: 'canonical_handoff_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.canonical_handoff_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: { operator: '<=', value: THRESHOLDS.canonical_handoff_p95_ms_max, unit: 'ms' },
    },
    {
      name: 'canonical_handoff_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.canonical_handoff_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: { operator: '===', value: THRESHOLDS.canonical_handoff_correctness_success_rate, unit: 'percent' },
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
