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
import { resolveMemoryCandidateContradiction } from '../../src/core/services/memory-inbox-contradiction-service.ts';
import { promoteMemoryCandidateEntry } from '../../src/core/services/memory-inbox-promotion-service.ts';

type Phase5MemoryInboxContradictionWorkloadResult =
  | {
      name: 'memory_inbox_contradiction';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'memory_inbox_contradiction_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase5MemoryInboxContradictionAcceptanceCheck {
  name:
    | 'memory_inbox_contradiction_p95_ms'
    | 'memory_inbox_contradiction_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  memory_inbox_contradiction_p95_ms_max: 100,
  memory_inbox_contradiction_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const DEFAULT_SCOPE_ID = 'workspace:default';
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase5-memory-inbox-contradiction.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase5-memory-inbox-contradiction-'));
const databasePath = join(tempDir, 'phase5-memory-inbox-contradiction.db');
const engine = new SQLiteEngine();

try {
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  const workloads: Phase5MemoryInboxContradictionWorkloadResult[] = [
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
    console.log('Phase 5 memory-inbox contradiction benchmark complete for sqlite');
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runLatencyWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxContradictionWorkloadResult, { name: 'memory_inbox_contradiction' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const challengedId = `phase5-contradiction-challenged-${sample}`;
    const challengerId = `phase5-contradiction-challenger-${sample}`;
    await seedPromotedCandidate(engine, challengedId);
    await seedStagedCandidate(engine, challengerId);

    const start = performance.now();
    await resolveMemoryCandidateContradiction(engine, {
      candidate_id: challengerId,
      challenged_candidate_id: challengedId,
      outcome: 'unresolved',
      review_reason: 'Latency sample keeps the contradiction explicit.',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'memory_inbox_contradiction',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxContradictionWorkloadResult, { name: 'memory_inbox_contradiction_correctness' }>> {
  let checks = 0;
  let passes = 0;

  await seedPromotedCandidate(engine, 'phase5-contradiction-rejected-old');
  await seedStagedCandidate(engine, 'phase5-contradiction-rejected-new');
  const rejected = await resolveMemoryCandidateContradiction(engine, {
    candidate_id: 'phase5-contradiction-rejected-new',
    challenged_candidate_id: 'phase5-contradiction-rejected-old',
    outcome: 'rejected',
    review_reason: 'Contradicted by stronger existing evidence.',
  });
  checks += 1;
  if (rejected.contradiction_entry.outcome === 'rejected' && rejected.candidate.status === 'rejected') {
    passes += 1;
  }

  await seedPromotedCandidate(engine, 'phase5-contradiction-unresolved-old');
  await seedStagedCandidate(engine, 'phase5-contradiction-unresolved-new');
  const unresolved = await resolveMemoryCandidateContradiction(engine, {
    candidate_id: 'phase5-contradiction-unresolved-new',
    challenged_candidate_id: 'phase5-contradiction-unresolved-old',
    outcome: 'unresolved',
    review_reason: 'Needs more evidence.',
  });
  checks += 1;
  if (unresolved.contradiction_entry.outcome === 'unresolved' && unresolved.candidate.status === 'staged_for_review') {
    passes += 1;
  }

  await seedPromotedCandidate(engine, 'phase5-contradiction-superseded-old');
  await seedPromotedCandidate(engine, 'phase5-contradiction-superseded-new');
  const superseded = await resolveMemoryCandidateContradiction(engine, {
    candidate_id: 'phase5-contradiction-superseded-new',
    challenged_candidate_id: 'phase5-contradiction-superseded-old',
    outcome: 'superseded',
    review_reason: 'Newer promoted evidence replaces the older candidate.',
  });
  checks += 1;
  if (superseded.contradiction_entry.outcome === 'superseded'
    && superseded.challenged_candidate.status === 'superseded'
    && superseded.supersession_entry != null) {
    passes += 1;
  }

  return {
    name: 'memory_inbox_contradiction_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

async function seedCapturedCandidate(engine: SQLiteEngine, id: string, scopeId = DEFAULT_SCOPE_ID) {
  await engine.createMemoryCandidateEntry({
    id,
    scope_id: scopeId,
    candidate_type: 'fact',
    proposed_content: 'Contradictions must remain explicit inside the inbox boundary.',
    source_refs: ['User, direct message, 2026-04-24 01:30 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.9,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/memory-inbox',
    reviewed_at: null,
    review_reason: null,
  });
}

async function seedStagedCandidate(engine: SQLiteEngine, id: string, scopeId = DEFAULT_SCOPE_ID) {
  await seedCapturedCandidate(engine, id, scopeId);
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'staged_for_review' });
}

async function seedPromotedCandidate(engine: SQLiteEngine, id: string, scopeId = DEFAULT_SCOPE_ID) {
  await seedStagedCandidate(engine, id, scopeId);
  await verifyMemoryCandidateEntry(engine, {
    id,
    verification_status: 'verified',
    verification_method: 'source_recheck',
    verification_evidence: `Verified contradiction benchmark fixture ${id}.`,
    verification_source_refs: [`Fixture verification for ${id}`],
    verified_at: '2026-06-16T00:00:00Z',
  });
  await promoteMemoryCandidateEntry(engine, {
    id,
    review_reason: `Promoted ${id} for contradiction benchmarking.`,
  });
}

function evaluateAcceptance(workloads: Phase5MemoryInboxContradictionWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'memory_inbox_contradiction');
  const correctness = workloads.find((workload) => workload.name === 'memory_inbox_contradiction_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing memory inbox contradiction benchmark workloads');
  }

  const checks: Phase5MemoryInboxContradictionAcceptanceCheck[] = [
    {
      name: 'memory_inbox_contradiction_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.memory_inbox_contradiction_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.memory_inbox_contradiction_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'memory_inbox_contradiction_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.memory_inbox_contradiction_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.memory_inbox_contradiction_correctness_success_rate,
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
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index]!;
}

function formatMeasuredMs(value: number): number {
  return Number(value.toFixed(2));
}

function formatPercent(value: number): number {
  return Number(value.toFixed(2));
}
