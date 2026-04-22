#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { evaluateScopeGate } from '../../src/core/services/scope-gate-service.ts';

type Phase4ScopeGateWorkloadResult =
  | {
      name: 'scope_gate';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'scope_gate_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase4ScopeGateAcceptanceCheck {
  name: 'scope_gate_p95_ms' | 'scope_gate_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  scope_gate_p95_ms_max: 100,
  scope_gate_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const args = new Set(process.argv.slice(2));

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase4-scope-gate.ts [--json]');
  process.exit(0);
}

const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase4-scope-gate-'));
const databasePath = join(tempDir, 'phase4-scope-gate.db');

let engine: BrainEngine | null = null;

try {
  const config = createLocalConfigDefaults({
    database_path: databasePath,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
  });

  engine = await createConnectedEngine(config);
  await engine.initSchema();
  await seedFixtures(engine);

  const workloads: Phase4ScopeGateWorkloadResult[] = [
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

  console.log(JSON.stringify(payload, null, 2));
} finally {
  if (engine) await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedFixtures(engine: BrainEngine): Promise<void> {
  await engine.createTaskThread({
    id: 'task-1',
    scope: 'personal',
    title: 'Personal planning',
    goal: 'Track routines',
    status: 'active',
    repo_path: null,
    branch_name: null,
    current_summary: 'Personal continuity only',
  });
}

async function runLatencyWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase4ScopeGateWorkloadResult, { name: 'scope_gate' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await evaluateScopeGate(engine, {
      intent: 'broad_synthesis',
      requested_scope: 'work',
      query: 'summarize the architecture docs',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'scope_gate',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase4ScopeGateWorkloadResult, { name: 'scope_gate_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const allow = await evaluateScopeGate(engine, {
    intent: 'broad_synthesis',
    requested_scope: 'work',
    query: 'summarize the architecture docs',
  });
  checks += 1;
  if (allow.resolved_scope === 'work' && allow.policy === 'allow') {
    passes += 1;
  }

  const task = await evaluateScopeGate(engine, {
    intent: 'task_resume',
    task_id: 'task-1',
  });
  checks += 1;
  if (task.resolved_scope === 'personal' && task.policy === 'allow') {
    passes += 1;
  }

  const deny = await evaluateScopeGate(engine, {
    intent: 'precision_lookup',
    query: 'remember my daily routine',
  });
  checks += 1;
  if (deny.resolved_scope === 'personal' && deny.policy === 'deny') {
    passes += 1;
  }

  const defer = await evaluateScopeGate(engine, {
    intent: 'broad_synthesis',
    query: 'help me remember this',
  });
  checks += 1;
  if (defer.resolved_scope === 'unknown' && defer.policy === 'defer') {
    passes += 1;
  }

  const mixed = await evaluateScopeGate(engine, {
    intent: 'broad_synthesis',
    requested_scope: 'mixed',
    query: 'connect my routines to project planning',
  });
  checks += 1;
  if (mixed.resolved_scope === 'mixed' && mixed.policy === 'deny') {
    passes += 1;
  }

  return {
    name: 'scope_gate_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase4ScopeGateWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'scope_gate');
  const correctness = workloads.find((workload) => workload.name === 'scope_gate_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing scope-gate workload results');
  }

  const checks: Phase4ScopeGateAcceptanceCheck[] = [
    {
      name: 'scope_gate_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.scope_gate_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.scope_gate_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'scope_gate_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.scope_gate_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.scope_gate_correctness_success_rate,
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
