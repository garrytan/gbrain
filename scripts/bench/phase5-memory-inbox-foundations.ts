#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import { advanceMemoryCandidateStatus } from '../../src/core/services/memory-inbox-service.ts';

type Phase5MemoryInboxWorkloadResult =
  | {
      name: 'memory_inbox_foundations';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'memory_inbox_foundations_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase5MemoryInboxAcceptanceCheck {
  name: 'memory_inbox_foundations_p95_ms' | 'memory_inbox_foundations_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  memory_inbox_foundations_p95_ms_max: 100,
  memory_inbox_foundations_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const DEFAULT_SCOPE_ID = 'workspace:default';
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase5-memory-inbox-foundations.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase5-memory-inbox-'));
const databasePath = join(tempDir, 'phase5-memory-inbox.db');
const engine = new SQLiteEngine();

try {
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  const workloads: Phase5MemoryInboxWorkloadResult[] = [
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
    console.log('Phase 5 memory-inbox foundations benchmark complete for sqlite');
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runLatencyWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxWorkloadResult, { name: 'memory_inbox_foundations' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const id = `phase5-latency-${sample}`;
    const start = performance.now();

    await engine.createMemoryCandidateEntry(buildCandidateInput(id));
    await engine.getMemoryCandidateEntry(id);
    await engine.listMemoryCandidateEntries({
      scope_id: DEFAULT_SCOPE_ID,
      status: 'captured',
      limit: 10,
      offset: 0,
    });
    await advanceMemoryCandidateStatus(engine, {
      id,
      next_status: 'candidate',
    });

    durations.push(performance.now() - start);
    await engine.deleteMemoryCandidateEntry(id);
  }

  return {
    name: 'memory_inbox_foundations',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxWorkloadResult, { name: 'memory_inbox_foundations_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const created = await engine.createMemoryCandidateEntry(buildCandidateInput('phase5-correctness-1'));
  checks += 1;
  if (
    created.scope_id === DEFAULT_SCOPE_ID
    && created.status === 'captured'
    && created.candidate_type === 'fact'
  ) {
    passes += 1;
  }

  const listed = await engine.listMemoryCandidateEntries({
    scope_id: DEFAULT_SCOPE_ID,
    status: 'captured',
    candidate_type: 'fact',
    limit: 10,
    offset: 0,
  });
  checks += 1;
  if (listed.some((entry) => entry.id === created.id)) {
    passes += 1;
  }

  const candidate = await advanceMemoryCandidateStatus(engine, {
    id: created.id,
    next_status: 'candidate',
  });
  const staged = await advanceMemoryCandidateStatus(engine, {
    id: created.id,
    next_status: 'staged_for_review',
    review_reason: 'Prepared for bounded human review.',
  });
  checks += 1;
  if (
    candidate.status === 'candidate'
    && staged.status === 'staged_for_review'
    && staged.review_reason === 'Prepared for bounded human review.'
    && staged.reviewed_at != null
  ) {
    passes += 1;
  }

  await engine.deleteMemoryCandidateEntry(created.id);
  checks += 1;
  if (await engine.getMemoryCandidateEntry(created.id) === null) {
    passes += 1;
  }

  return {
    name: 'memory_inbox_foundations_correctness',
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

function evaluateAcceptance(workloads: Phase5MemoryInboxWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'memory_inbox_foundations');
  const correctness = workloads.find((workload) => workload.name === 'memory_inbox_foundations_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing memory inbox benchmark workloads');
  }

  const checks: Phase5MemoryInboxAcceptanceCheck[] = [
    {
      name: 'memory_inbox_foundations_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.memory_inbox_foundations_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.memory_inbox_foundations_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'memory_inbox_foundations_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.memory_inbox_foundations_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.memory_inbox_foundations_correctness_success_rate,
        unit: 'percent',
      },
    },
  ];

  const readinessStatus = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  return {
    readiness_status: readinessStatus,
    phase5_status: readinessStatus,
    checks,
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
}

function formatMeasuredMs(value: number): number {
  return Number(value.toFixed(3));
}

function formatPercent(value: number): number {
  return Number(value.toFixed(2));
}
