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
import { supersedeMemoryCandidateEntry } from '../../src/core/services/memory-inbox-supersession-service.ts';

type Phase5MemoryInboxSupersessionWorkloadResult =
  | {
      name: 'memory_inbox_supersession';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'memory_inbox_supersession_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase5MemoryInboxSupersessionAcceptanceCheck {
  name:
    | 'memory_inbox_supersession_p95_ms'
    | 'memory_inbox_supersession_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  memory_inbox_supersession_p95_ms_max: 100,
  memory_inbox_supersession_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const DEFAULT_SCOPE_ID = 'workspace:default';
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase5-memory-inbox-supersession.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase5-memory-inbox-supersession-'));
const databasePath = join(tempDir, 'phase5-memory-inbox-supersession.db');
const engine = new SQLiteEngine();

try {
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  const workloads: Phase5MemoryInboxSupersessionWorkloadResult[] = [
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
    console.log('Phase 5 memory-inbox supersession benchmark complete for sqlite');
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runLatencyWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxSupersessionWorkloadResult, { name: 'memory_inbox_supersession' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const oldId = `phase5-supersession-old-${sample}`;
    const newId = `phase5-supersession-new-${sample}`;
    await seedPromotedCandidate(engine, oldId);
    await seedPromotedCandidate(engine, newId);

    const start = performance.now();
    await supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: oldId,
      replacement_candidate_id: newId,
      review_reason: 'Newer promoted evidence replaced the older promoted candidate.',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'memory_inbox_supersession',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: SQLiteEngine,
): Promise<Extract<Phase5MemoryInboxSupersessionWorkloadResult, { name: 'memory_inbox_supersession_correctness' }>> {
  let checks = 0;
  let passes = 0;

  await seedPromotedCandidate(engine, 'phase5-supersession-correctness-old');
  await seedPromotedCandidate(engine, 'phase5-supersession-correctness-new');

  const result = await supersedeMemoryCandidateEntry(engine, {
    superseded_candidate_id: 'phase5-supersession-correctness-old',
    replacement_candidate_id: 'phase5-supersession-correctness-new',
    review_reason: 'Newer promoted evidence replaced the earlier candidate.',
  });
  checks += 1;
  if (result.superseded_candidate.status === 'superseded'
    && result.supersession_entry.replacement_candidate_id === 'phase5-supersession-correctness-new') {
    passes += 1;
  }

  const persisted = await engine.getMemoryCandidateSupersessionEntry(result.supersession_entry.id);
  checks += 1;
  if (persisted?.superseded_candidate_id === 'phase5-supersession-correctness-old') {
    passes += 1;
  }

  await seedPromotedCandidate(engine, 'phase5-supersession-correctness-self');
  let selfBlocked = false;
  try {
    await supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'phase5-supersession-correctness-self',
      replacement_candidate_id: 'phase5-supersession-correctness-self',
    });
  } catch (error) {
    selfBlocked = error instanceof Error
      && error.name === 'MemoryInboxServiceError'
      && (error as { code?: string }).code === 'invalid_status_transition';
  }
  checks += 1;
  if (selfBlocked && (await engine.getMemoryCandidateEntry('phase5-supersession-correctness-self'))?.status === 'promoted') {
    passes += 1;
  }

  await seedPromotedCandidate(engine, 'phase5-supersession-correctness-scope-old', 'workspace:alpha');
  await seedPromotedCandidate(engine, 'phase5-supersession-correctness-scope-new', 'workspace:beta');
  let scopeBlocked = false;
  try {
    await supersedeMemoryCandidateEntry(engine, {
      superseded_candidate_id: 'phase5-supersession-correctness-scope-old',
      replacement_candidate_id: 'phase5-supersession-correctness-scope-new',
    });
  } catch (error) {
    scopeBlocked = error instanceof Error
      && error.name === 'MemoryInboxServiceError'
      && (error as { code?: string }).code === 'invalid_status_transition';
  }
  checks += 1;
  if (scopeBlocked && (await engine.getMemoryCandidateEntry('phase5-supersession-correctness-scope-old'))?.status === 'promoted') {
    passes += 1;
  }

  return {
    name: 'memory_inbox_supersession_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

async function seedPromotedCandidate(
  engine: SQLiteEngine,
  id: string,
  scopeId = DEFAULT_SCOPE_ID,
) {
  await engine.createMemoryCandidateEntry(buildCandidateInput(id, scopeId));
  await advanceMemoryCandidateStatus(engine, { id, next_status: 'candidate' });
  await advanceMemoryCandidateStatus(engine, {
    id,
    next_status: 'staged_for_review',
    review_reason: 'Prepared for promotion.',
  });
  await verifyMemoryCandidateEntry(engine, {
    id,
    verification_status: 'verified',
    verification_method: 'source_recheck',
    verification_evidence: `Verified supersession benchmark fixture ${id}.`,
    verification_source_refs: [`Fixture verification for ${id}`],
    verified_at: '2026-06-16T00:00:00Z',
  });
  return promoteMemoryCandidateEntry(engine, {
    id,
    review_reason: 'Promoted before supersession benchmark.',
  });
}

function buildCandidateInput(id: string, scopeId = DEFAULT_SCOPE_ID) {
  return {
    id,
    scope_id: scopeId,
    candidate_type: 'fact' as const,
    proposed_content: 'Supersession should preserve explicit governance history.',
    source_refs: ['User, direct message, 2026-04-23 11:35 PM KST'],
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

function evaluateAcceptance(workloads: Phase5MemoryInboxSupersessionWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'memory_inbox_supersession');
  const correctness = workloads.find((workload) => workload.name === 'memory_inbox_supersession_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing memory inbox supersession benchmark workloads');
  }

  const checks: Phase5MemoryInboxSupersessionAcceptanceCheck[] = [
    {
      name: 'memory_inbox_supersession_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.memory_inbox_supersession_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.memory_inbox_supersession_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'memory_inbox_supersession_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.memory_inbox_supersession_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.memory_inbox_supersession_correctness_success_rate,
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
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function formatMeasuredMs(value: number): number {
  return Number(value.toFixed(2));
}

function formatPercent(value: number): number {
  return Number(value.toFixed(2));
}
