#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import {
  advanceMemoryCandidateStatus,
  rejectMemoryCandidateEntry,
} from '../../src/core/services/memory-inbox-service.ts';

type Phase5MemoryInboxRejectionWorkloadResult =
  | {
      name: 'memory_inbox_rejection';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'memory_inbox_rejection_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase5MemoryInboxRejectionAcceptanceCheck {
  name: 'memory_inbox_rejection_p95_ms' | 'memory_inbox_rejection_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  memory_inbox_rejection_p95_ms_max: 100,
  memory_inbox_rejection_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const DEFAULT_SCOPE_ID = 'workspace:default';
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase5-memory-inbox-rejection.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase5-memory-inbox-rejection-'));
const databasePath = join(tempDir, 'phase5-memory-inbox-rejection.db');
const engine = new SQLiteEngine();

try {
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  const workloads: Phase5MemoryInboxRejectionWorkloadResult[] = [
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
    console.log('Phase 5 memory-inbox rejection benchmark complete for sqlite');
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runLatencyWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxRejectionWorkloadResult, { name: 'memory_inbox_rejection' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const id = `phase5-rejection-latency-${sample}`;
    await engine.createMemoryCandidateEntry(buildCandidateInput(id));
    await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
    await advanceMemoryCandidateStatus(engine, {
      id,
      next_status: 'staged_for_review',
      review_reason: 'Prepared for explicit decision.',
    });

    const start = performance.now();
    await rejectMemoryCandidateEntry(engine, {
      id,
      review_reason: 'Insufficient provenance for durable memory.',
    });

    durations.push(performance.now() - start);
    await engine.deleteMemoryCandidateEntry(id);
  }

  return {
    name: 'memory_inbox_rejection',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxRejectionWorkloadResult, { name: 'memory_inbox_rejection_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const created = await engine.createMemoryCandidateEntry(buildCandidateInput('phase5-rejection-correctness-1'));
  await advanceMemoryCandidateStatus(engine, { id: created.id, next_status: 'candidate' });
  const staged = await advanceMemoryCandidateStatus(engine, {
    id: created.id,
    next_status: 'staged_for_review',
    review_reason: 'Prepared for explicit decision.',
  });
  checks += 1;
  if (staged.status === 'staged_for_review') {
    passes += 1;
  }

  const rejected = await rejectMemoryCandidateEntry(engine, {
    id: created.id,
    review_reason: 'Insufficient provenance for durable memory.',
  });
  checks += 1;
  if (
    rejected.status === 'rejected'
    && rejected.review_reason === 'Insufficient provenance for durable memory.'
    && rejected.reviewed_at != null
  ) {
    passes += 1;
  }

  const listedRejected = await engine.listMemoryCandidateEntries({
    scope_id: DEFAULT_SCOPE_ID,
    status: 'rejected',
    limit: 10,
    offset: 0,
  });
  checks += 1;
  if (listedRejected.some((entry) => entry.id === created.id)) {
    passes += 1;
  }

  await engine.deleteMemoryCandidateEntry(created.id);
  checks += 1;
  if (await engine.getMemoryCandidateEntry(created.id) === null) {
    passes += 1;
  }

  return {
    name: 'memory_inbox_rejection_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function buildCandidateInput(id: string) {
  return {
    id,
    scope_id: DEFAULT_SCOPE_ID,
    candidate_type: 'fact' as const,
    proposed_content: 'Context maps can propose a note update candidate.',
    source_refs: ['User, direct message, 2026-04-22 3:01 PM KST'],
    generated_by: 'manual' as const,
    extraction_kind: 'manual' as const,
    confidence_score: 0.95,
    importance_score: 0.8,
    recurrence_score: 0.2,
    sensitivity: 'work' as const,
    status: 'captured' as const,
    target_object_type: 'curated_note' as const,
    target_object_id: 'concepts/note-manifest',
    reviewed_at: null,
    review_reason: null,
  };
}

function evaluateAcceptance(workloads: Phase5MemoryInboxRejectionWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'memory_inbox_rejection');
  const correctness = workloads.find((workload) => workload.name === 'memory_inbox_rejection_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing memory inbox rejection benchmark workloads');
  }

  const checks: Phase5MemoryInboxRejectionAcceptanceCheck[] = [
    {
      name: 'memory_inbox_rejection_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.memory_inbox_rejection_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.memory_inbox_rejection_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'memory_inbox_rejection_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.memory_inbox_rejection_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.memory_inbox_rejection_correctness_success_rate,
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
  return sorted[index];
}

function formatMeasuredMs(value: number): number {
  return Number(value.toFixed(2));
}

function formatPercent(value: number): number {
  return Number(value.toFixed(2));
}
