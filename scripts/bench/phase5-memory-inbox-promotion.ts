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

type Phase5MemoryInboxPromotionWorkloadResult =
  | {
      name: 'memory_inbox_promotion';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'memory_inbox_promotion_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase5MemoryInboxPromotionAcceptanceCheck {
  name:
    | 'memory_inbox_promotion_p95_ms'
    | 'memory_inbox_promotion_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  memory_inbox_promotion_p95_ms_max: 100,
  memory_inbox_promotion_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const DEFAULT_SCOPE_ID = 'workspace:default';
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase5-memory-inbox-promotion.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase5-memory-inbox-promotion-'));
const databasePath = join(tempDir, 'phase5-memory-inbox-promotion.db');
const engine = new SQLiteEngine();

try {
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  const workloads: Phase5MemoryInboxPromotionWorkloadResult[] = [
    await runCorrectnessWorkload(engine),
    await runLatencyWorkload(engine),
  ];

  const payload = {
    generated_at: new Date().toISOString(),
    engine: 'sqlite',
    phase: 'phase5',
    workloads,
    acceptance: evaluateAcceptance(workloads),
  };

  if (jsonOutput) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('Phase 5 memory-inbox promotion benchmark complete for sqlite');
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runLatencyWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxPromotionWorkloadResult, { name: 'memory_inbox_promotion' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const id = `phase5-promotion-latency-${sample}`;
    await engine.createMemoryCandidateEntry(buildCandidateInput(id));
    await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
    await advanceMemoryCandidateStatus(engine, {
      id,
      next_status: 'staged_for_review',
      review_reason: 'Prepared for promotion.',
    });
    await verifyFixtureCandidate(engine, id);

    const start = performance.now();
    await promoteMemoryCandidateEntry(engine, {
      id,
      review_reason: 'Promoted after passing preflight.',
    });
    durations.push(performance.now() - start);

    await engine.deleteMemoryCandidateEntry(id);
  }

  return {
    name: 'memory_inbox_promotion',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxPromotionWorkloadResult, { name: 'memory_inbox_promotion_correctness' }>> {
  let checks = 0;
  let passes = 0;

  await engine.createMemoryCandidateEntry(buildCandidateInput('phase5-promotion-correctness-allow'));
  await advanceMemoryCandidateStatus(engine, { id: 'phase5-promotion-correctness-allow', next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, {
    id: 'phase5-promotion-correctness-allow',
    next_status: 'staged_for_review',
    review_reason: 'Prepared for promotion.',
  });
  await verifyFixtureCandidate(engine, 'phase5-promotion-correctness-allow');
  const promoted = await promoteMemoryCandidateEntry(engine, {
    id: 'phase5-promotion-correctness-allow',
    review_reason: 'Promoted after passing preflight.',
  });
  checks += 1;
  if (promoted.status === 'promoted' && promoted.review_reason === 'Promoted after passing preflight.') {
    passes += 1;
  }

  const listedPromoted = await engine.listMemoryCandidateEntries({
    scope_id: DEFAULT_SCOPE_ID,
    status: 'promoted',
    limit: 10,
    offset: 0,
  });
  checks += 1;
  if (listedPromoted.some((entry) => entry.id === 'phase5-promotion-correctness-allow')) {
    passes += 1;
  }

  await engine.createMemoryCandidateEntry({
    ...buildCandidateInput('phase5-promotion-correctness-blocked'),
    status: 'staged_for_review',
    source_refs: [],
  });
  let blockedByPreflight = false;
  try {
    await promoteMemoryCandidateEntry(engine, {
      id: 'phase5-promotion-correctness-blocked',
      review_reason: 'Should not promote without provenance.',
    });
  } catch (error) {
    blockedByPreflight = error instanceof Error
      && error.name === 'MemoryInboxServiceError'
      && (error as { code?: string }).code === 'promotion_preflight_failed';
  }
  checks += 1;
  const blockedEntry = await engine.getMemoryCandidateEntry('phase5-promotion-correctness-blocked');
  if (blockedByPreflight && blockedEntry?.status === 'staged_for_review') {
    passes += 1;
  }

  await engine.createMemoryCandidateEntry(buildCandidateInput('phase5-promotion-correctness-not-staged'));
  let blockedByStatus = false;
  try {
    await promoteMemoryCandidateEntry(engine, {
      id: 'phase5-promotion-correctness-not-staged',
    });
  } catch (error) {
    blockedByStatus = error instanceof Error
      && error.name === 'MemoryInboxServiceError'
      && (error as { code?: string }).code === 'invalid_status_transition';
  }
  checks += 1;
  const notStagedEntry = await engine.getMemoryCandidateEntry('phase5-promotion-correctness-not-staged');
  if (blockedByStatus && notStagedEntry?.status === 'captured') {
    passes += 1;
  }

  for (const id of [
    'phase5-promotion-correctness-allow',
    'phase5-promotion-correctness-blocked',
    'phase5-promotion-correctness-not-staged',
  ]) {
    await engine.deleteMemoryCandidateEntry(id);
  }

  return {
    name: 'memory_inbox_promotion_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

async function verifyFixtureCandidate(engine: SQLiteEngine, id: string) {
  await verifyMemoryCandidateEntry(engine, {
    id,
    verification_status: 'verified',
    verification_method: 'source_recheck',
    verification_evidence: `Verified promotion benchmark fixture ${id}.`,
    verification_source_refs: [`Fixture verification for ${id}`],
    verified_at: '2026-06-16T00:00:00Z',
  });
}

function buildCandidateInput(id: string) {
  return {
    id,
    scope_id: DEFAULT_SCOPE_ID,
    candidate_type: 'fact' as const,
    proposed_content: 'Promotion should write explicit governance state.',
    source_refs: ['User, direct message, 2026-04-23 8:20 PM KST'],
    generated_by: 'manual' as const,
    extraction_kind: 'manual' as const,
    confidence_score: 0.9,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work' as const,
    status: 'captured' as const,
    target_object_type: 'curated_note' as const,
    target_object_id: 'concepts/memory-inbox',
    reviewed_at: null,
    review_reason: null,
  };
}

function evaluateAcceptance(workloads: Phase5MemoryInboxPromotionWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'memory_inbox_promotion');
  const correctness = workloads.find((workload) => workload.name === 'memory_inbox_promotion_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing memory inbox promotion benchmark workloads');
  }

  const checks: Phase5MemoryInboxPromotionAcceptanceCheck[] = [
    {
      name: 'memory_inbox_promotion_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.memory_inbox_promotion_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.memory_inbox_promotion_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'memory_inbox_promotion_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.memory_inbox_promotion_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.memory_inbox_promotion_correctness_success_rate,
        unit: 'percent',
      },
    },
  ];

  const allPass = checks.every((check) => check.status === 'pass');
  return {
    readiness_status: allPass ? 'pass' : 'fail',
    phase5_status: allPass ? 'pass' : 'fail',
    checks,
  };
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function formatMeasuredMs(value: number): number {
  return Number(value.toFixed(2));
}

function formatPercent(value: number): number {
  return Number(value.toFixed(2));
}
