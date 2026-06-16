#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import {
  advanceMemoryCandidateStatus,
  preflightPromoteMemoryCandidate,
  verifyMemoryCandidateEntry,
} from '../../src/core/services/memory-inbox-service.ts';

type Phase5MemoryInboxPromotionPreflightWorkloadResult =
  | {
      name: 'memory_inbox_promotion_preflight';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'memory_inbox_promotion_preflight_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase5MemoryInboxPromotionPreflightAcceptanceCheck {
  name:
    | 'memory_inbox_promotion_preflight_p95_ms'
    | 'memory_inbox_promotion_preflight_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  memory_inbox_promotion_preflight_p95_ms_max: 100,
  memory_inbox_promotion_preflight_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const DEFAULT_SCOPE_ID = 'workspace:default';
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase5-memory-inbox-promotion-preflight.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase5-memory-inbox-promotion-preflight-'));
const databasePath = join(tempDir, 'phase5-memory-inbox-promotion-preflight.db');
const engine = new SQLiteEngine();

try {
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  const workloads: Phase5MemoryInboxPromotionPreflightWorkloadResult[] = [
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
    console.log('Phase 5 memory-inbox promotion-preflight benchmark complete for sqlite');
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runLatencyWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxPromotionPreflightWorkloadResult, { name: 'memory_inbox_promotion_preflight' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const id = `phase5-promotion-preflight-latency-${sample}`;
    await engine.createMemoryCandidateEntry(buildCandidateInput(id));
    await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
    await advanceMemoryCandidateStatus(engine, {
      id,
      next_status: 'staged_for_review',
      review_reason: 'Prepared for promotion review.',
    });
    await verifyFixtureCandidate(engine, id);

    const start = performance.now();
    await preflightPromoteMemoryCandidate(engine, { id });
    durations.push(performance.now() - start);

    await engine.deleteMemoryCandidateEntry(id);
  }

  return {
    name: 'memory_inbox_promotion_preflight',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxPromotionPreflightWorkloadResult, { name: 'memory_inbox_promotion_preflight_correctness' }>> {
  let checks = 0;
  let passes = 0;

  await engine.createMemoryCandidateEntry(buildCandidateInput('phase5-promotion-preflight-allow'));
  await advanceMemoryCandidateStatus(engine, { id: 'phase5-promotion-preflight-allow', next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, {
    id: 'phase5-promotion-preflight-allow',
    next_status: 'staged_for_review',
    review_reason: 'Ready for promotion review.',
  });
  await verifyFixtureCandidate(engine, 'phase5-promotion-preflight-allow');
  const allow = await preflightPromoteMemoryCandidate(engine, { id: 'phase5-promotion-preflight-allow' });
  checks += 1;
  if (allow.decision === 'allow' && allow.reasons[0] === 'candidate_ready_for_promotion') {
    passes += 1;
  }

  await engine.createMemoryCandidateEntry({
    ...buildCandidateInput('phase5-promotion-preflight-deny'),
    status: 'staged_for_review',
    source_refs: [],
  });
  const deny = await preflightPromoteMemoryCandidate(engine, { id: 'phase5-promotion-preflight-deny' });
  checks += 1;
  if (deny.decision === 'deny' && deny.reasons.includes('candidate_missing_provenance')) {
    passes += 1;
  }

  await engine.createMemoryCandidateEntry({
    ...buildCandidateInput('phase5-promotion-preflight-scope'),
    status: 'staged_for_review',
    sensitivity: 'personal',
  });
  const scopeConflict = await preflightPromoteMemoryCandidate(engine, { id: 'phase5-promotion-preflight-scope' });
  checks += 1;
  if (scopeConflict.decision === 'deny' && scopeConflict.reasons.includes('candidate_scope_conflict')) {
    passes += 1;
  }

  await engine.createMemoryCandidateEntry({
    ...buildCandidateInput('phase5-promotion-preflight-defer'),
    status: 'staged_for_review',
    sensitivity: 'unknown',
  });
  await verifyFixtureCandidate(engine, 'phase5-promotion-preflight-defer');
  const defer = await preflightPromoteMemoryCandidate(engine, { id: 'phase5-promotion-preflight-defer' });
  checks += 1;
  if (defer.decision === 'defer' && defer.reasons.includes('candidate_unknown_sensitivity')) {
    passes += 1;
  }

  await engine.createMemoryCandidateEntry({
    ...buildCandidateInput('phase5-promotion-preflight-procedure'),
    status: 'staged_for_review',
    candidate_type: 'procedure',
    target_object_type: 'procedure',
    target_object_id: 'procedures/rebuild-context-map',
  });
  await verifyFixtureCandidate(engine, 'phase5-promotion-preflight-procedure');
  const procedure = await preflightPromoteMemoryCandidate(engine, { id: 'phase5-promotion-preflight-procedure' });
  checks += 1;
  if (procedure.decision === 'allow' && procedure.reasons[0] === 'candidate_ready_for_promotion') {
    passes += 1;
  }

  await engine.createMemoryCandidateEntry({
    ...buildCandidateInput('phase5-promotion-preflight-missing-target'),
    status: 'staged_for_review',
    target_object_id: '   ',
  });
  const missingTarget = await preflightPromoteMemoryCandidate(engine, { id: 'phase5-promotion-preflight-missing-target' });
  checks += 1;
  if (missingTarget.decision === 'deny' && missingTarget.reasons.includes('candidate_missing_target_object')) {
    passes += 1;
  }

  await engine.createMemoryCandidateEntry({
    ...buildCandidateInput('phase5-promotion-preflight-other'),
    proposed_content: 'Other target fixture has a distinct checked note for promotion preflight.',
    status: 'staged_for_review',
    target_object_type: 'other',
    target_object_id: 'misc/unknown-target',
  });
  await verifyFixtureCandidate(engine, 'phase5-promotion-preflight-other');
  const otherTarget = await preflightPromoteMemoryCandidate(engine, { id: 'phase5-promotion-preflight-other' });
  checks += 1;
  if (otherTarget.decision === 'allow' && otherTarget.reasons[0] === 'candidate_ready_for_promotion') {
    passes += 1;
  }

  for (const id of [
    'phase5-promotion-preflight-allow',
    'phase5-promotion-preflight-deny',
    'phase5-promotion-preflight-scope',
    'phase5-promotion-preflight-defer',
    'phase5-promotion-preflight-procedure',
    'phase5-promotion-preflight-missing-target',
    'phase5-promotion-preflight-other',
  ]) {
    await engine.deleteMemoryCandidateEntry(id);
  }

  return {
    name: 'memory_inbox_promotion_preflight_correctness',
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
    verification_evidence: `Verified promotion preflight benchmark fixture ${id}.`,
    verification_source_refs: [`Fixture verification for ${id}`],
    verified_at: '2026-06-16T00:00:00Z',
  });
}

function buildCandidateInput(id: string) {
  return {
    id,
    scope_id: DEFAULT_SCOPE_ID,
    candidate_type: 'fact' as const,
    proposed_content: 'Promotion preflight should remain deterministic and read-only.',
    source_refs: ['User, direct message, 2026-04-23 7:30 PM KST'],
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

function evaluateAcceptance(workloads: Phase5MemoryInboxPromotionPreflightWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'memory_inbox_promotion_preflight');
  const correctness = workloads.find((workload) => workload.name === 'memory_inbox_promotion_preflight_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing memory inbox promotion-preflight benchmark workloads');
  }

  const checks: Phase5MemoryInboxPromotionPreflightAcceptanceCheck[] = [
    {
      name: 'memory_inbox_promotion_preflight_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.memory_inbox_promotion_preflight_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.memory_inbox_promotion_preflight_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'memory_inbox_promotion_preflight_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.memory_inbox_promotion_preflight_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.memory_inbox_promotion_preflight_correctness_success_rate,
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
