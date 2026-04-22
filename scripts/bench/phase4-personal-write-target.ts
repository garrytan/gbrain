#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { selectPersonalWriteTarget } from '../../src/core/services/personal-write-target-service.ts';

type Phase4PersonalWriteTargetWorkloadResult =
  | {
      name: 'personal_write_target';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'personal_write_target_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase4PersonalWriteTargetAcceptanceCheck {
  name: 'personal_write_target_p95_ms' | 'personal_write_target_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  personal_write_target_p95_ms_max: 100,
  personal_write_target_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase4-personal-write-target.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase4-personal-write-target-'));
const databasePath = join(tempDir, 'phase4-personal-write-target.db');

let engine: BrainEngine | null = null;

try {
  const config = createLocalConfigDefaults({
    database_path: databasePath,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
  });

  engine = await createConnectedEngine(config);
  await engine.initSchema();

  const workloads: Phase4PersonalWriteTargetWorkloadResult[] = [
    await runCorrectnessWorkload(engine),
    await runLatencyWorkload(engine),
  ];

  const payload = {
    generated_at: new Date().toISOString(),
    engine: config.engine,
    phase: 'phase4',
    workloads,
    acceptance: evaluateAcceptance(workloads),
  };

  if (jsonOutput) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Phase 4 personal-write-target benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function runLatencyWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase4PersonalWriteTargetWorkloadResult, { name: 'personal_write_target' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await selectPersonalWriteTarget(engine, {
      target_kind: 'profile_memory',
      subject: 'daily routine',
      query: 'remember my daily routine',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'personal_write_target',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase4PersonalWriteTargetWorkloadResult, { name: 'personal_write_target_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const profile = await selectPersonalWriteTarget(engine, {
    target_kind: 'profile_memory',
    subject: 'daily routine',
    query: 'remember my daily routine',
  });
  checks += 1;
  if (profile.selection_reason === 'direct_personal_write_target' && profile.route?.target_kind === 'profile_memory') {
    passes += 1;
  }

  const episode = await selectPersonalWriteTarget(engine, {
    target_kind: 'personal_episode',
    title: 'Morning reset',
    query: 'remember my travel recovery routine',
  });
  checks += 1;
  if (episode.selection_reason === 'direct_personal_write_target' && episode.route?.target_kind === 'personal_episode') {
    passes += 1;
  }

  const denied = await selectPersonalWriteTarget(engine, {
    target_kind: 'profile_memory',
    subject: 'architecture preference',
    query: 'summarize the architecture docs',
    requested_scope: 'work',
  });
  checks += 1;
  if (denied.selection_reason === 'unsupported_scope_intent' && denied.route === null) {
    passes += 1;
  }

  const deferred = await selectPersonalWriteTarget(engine, {
    target_kind: 'profile_memory',
    subject: 'reference entry',
    query: 'help me remember this',
  });
  checks += 1;
  if (deferred.selection_reason === 'insufficient_signal' && deferred.route === null) {
    passes += 1;
  }

  return {
    name: 'personal_write_target_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase4PersonalWriteTargetWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'personal_write_target');
  const correctness = workloads.find((workload) => workload.name === 'personal_write_target_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing personal-write-target workload results');
  }

  const checks: Phase4PersonalWriteTargetAcceptanceCheck[] = [
    {
      name: 'personal_write_target_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.personal_write_target_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.personal_write_target_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'personal_write_target_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.personal_write_target_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.personal_write_target_correctness_success_rate,
        unit: 'percent',
      },
    },
  ];

  const readinessStatus = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  return {
    readiness_status: readinessStatus,
    phase4_status: readinessStatus,
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
