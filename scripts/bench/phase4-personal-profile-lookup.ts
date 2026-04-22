#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { getPersonalProfileLookupRoute } from '../../src/core/services/personal-profile-lookup-route-service.ts';

type Phase4PersonalProfileLookupWorkloadResult =
  | {
      name: 'personal_profile_lookup_route';
      status: 'measured';
      unit: 'ms';
      p50_ms: number;
      p95_ms: number;
    }
  | {
      name: 'personal_profile_lookup_route_correctness';
      status: 'measured';
      unit: 'percent';
      success_rate: number;
    };

interface Phase4PersonalProfileLookupAcceptanceCheck {
  name: 'personal_profile_lookup_route_p95_ms' | 'personal_profile_lookup_route_correctness_success_rate';
  status: 'pass' | 'fail';
  actual: number;
  threshold: {
    operator: '<=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
}

const THRESHOLDS = {
  personal_profile_lookup_route_p95_ms_max: 100,
  personal_profile_lookup_route_correctness_success_rate: 100,
} as const;

const SAMPLE_COUNT = 5;
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase4-personal-profile-lookup.ts [--json]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase4-personal-profile-lookup-'));
const databasePath = join(tempDir, 'phase4-personal-profile-lookup.db');

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

  const workloads: Phase4PersonalProfileLookupWorkloadResult[] = [
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
    console.log(`Phase 4 personal-profile-lookup benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedFixtures(engine: BrainEngine): Promise<void> {
  await engine.upsertProfileMemoryEntry({
    id: 'profile-1',
    scope_id: 'personal:default',
    profile_type: 'routine',
    subject: 'daily routine',
    content: 'Wake at 7 AM, review priorities, then write.',
    source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
    sensitivity: 'personal',
    export_status: 'private_only',
    last_confirmed_at: new Date('2026-04-22T00:05:00.000Z'),
    superseded_by: null,
  });
  await engine.upsertProfileMemoryEntry({
    id: 'profile-2',
    scope_id: 'personal:default',
    profile_type: 'preference',
    subject: 'daily routine',
    content: 'Prefer a quiet start before meetings.',
    source_refs: ['User, direct message, 2026-04-22 9:07 AM KST'],
    sensitivity: 'personal',
    export_status: 'private_only',
    last_confirmed_at: null,
    superseded_by: null,
  });
}

async function runLatencyWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase4PersonalProfileLookupWorkloadResult, { name: 'personal_profile_lookup_route' }>> {
  const durations: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const start = performance.now();
    await getPersonalProfileLookupRoute(engine, {
      subject: 'daily routine',
      profile_type: 'routine',
    });
    durations.push(performance.now() - start);
  }

  return {
    name: 'personal_profile_lookup_route',
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runCorrectnessWorkload(
  engine: BrainEngine,
): Promise<Extract<Phase4PersonalProfileLookupWorkloadResult, { name: 'personal_profile_lookup_route_correctness' }>> {
  let checks = 0;
  let passes = 0;

  const direct = await getPersonalProfileLookupRoute(engine, {
    subject: 'daily routine',
    profile_type: 'routine',
  });
  checks += 1;
  if (direct.selection_reason === 'direct_subject_match' && direct.route?.profile_memory_id === 'profile-1') {
    passes += 1;
  }

  const ambiguous = await getPersonalProfileLookupRoute(engine, {
    subject: 'daily routine',
  });
  checks += 1;
  if (ambiguous.selection_reason === 'ambiguous_subject_match' && ambiguous.candidate_count === 2 && ambiguous.route === null) {
    passes += 1;
  }

  const missing = await getPersonalProfileLookupRoute(engine, {
    subject: 'sleep routine',
  });
  checks += 1;
  if (missing.selection_reason === 'no_match' && missing.route === null) {
    passes += 1;
  }

  return {
    name: 'personal_profile_lookup_route_correctness',
    status: 'measured',
    unit: 'percent',
    success_rate: formatPercent((passes / checks) * 100),
  };
}

function evaluateAcceptance(workloads: Phase4PersonalProfileLookupWorkloadResult[]) {
  const latency = workloads.find((workload) => workload.name === 'personal_profile_lookup_route');
  const correctness = workloads.find((workload) => workload.name === 'personal_profile_lookup_route_correctness');
  if (!latency || !correctness) {
    throw new Error('Missing personal-profile-lookup workload results');
  }

  const checks: Phase4PersonalProfileLookupAcceptanceCheck[] = [
    {
      name: 'personal_profile_lookup_route_p95_ms',
      status: latency.p95_ms <= THRESHOLDS.personal_profile_lookup_route_p95_ms_max ? 'pass' : 'fail',
      actual: latency.p95_ms,
      threshold: {
        operator: '<=',
        value: THRESHOLDS.personal_profile_lookup_route_p95_ms_max,
        unit: 'ms',
      },
    },
    {
      name: 'personal_profile_lookup_route_correctness_success_rate',
      status: correctness.success_rate === THRESHOLDS.personal_profile_lookup_route_correctness_success_rate ? 'pass' : 'fail',
      actual: correctness.success_rate,
      threshold: {
        operator: '===',
        value: THRESHOLDS.personal_profile_lookup_route_correctness_success_rate,
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
